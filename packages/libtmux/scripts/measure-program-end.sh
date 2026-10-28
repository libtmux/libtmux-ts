#!/usr/bin/env bash
# Measure how often tmux reaps a pane before reading a program's last output,
# and whether the run's end mark catches every such run.
#
# Usage: scripts/measure-program-end.sh <runs per probe> <tmux>...
# Each tmux runs three probes in parallel, so the host is loaded, on private sockets.
set -u
runs=${1:?runs per probe}
shift

# The wrapper's shapes, as program_start.ts writes them: the program runs as
# "$0" "$@" in a subshell, then the shell marks the end and, in "linger",
# waits 50 ms before exiting.
MARK='m=$1; shift; (exec "$0" "$@"); s=$?; printf '"'"'\033\\\033]7;%s\007'"'"' "$m"'
declare -A SHAPE=(
  [bare]='exec "$0" "$@"'
  [mark]="$MARK; exit \"\$s\""
  [linger]="$MARK; sleep 0.05; exit \"\$s\""
)

probe() { # tmux shape runs socket -> "whole marked marked-but-cut"
  local tmux=$1 shape=$2 n=$3 socket=$4 whole=0 marked=0 wrong=0 pane w m
  T() { "$tmux" -L "$socket" -f /dev/null "$@"; }
  T new-session -d -s keep
  for _ in $(seq 1 "$n"); do
    T new-session -d -s run -x 80 -y 24 -- true \; set -t =run: history-limit 5000 \; \
      set -w -t =run: remain-on-exit on \; set -w -t =run: remain-on-exit-format ''
    pane=$(T display -p -t =run: '#{pane_id}')
    if [ "$shape" = bare ]; then
      T respawn-pane -k -t "$pane" -- sh -c "${SHAPE[$shape]}" seq 1 3000 \; \
        wait-for -E -F "#{==:#{pane},$pane}" pane-died
    else
      T respawn-pane -k -t "$pane" -- sh -c "${SHAPE[$shape]}" seq ltx-mark 1 3000 \; \
        wait-for -E -F "#{==:#{pane},$pane}" pane-died
    fi
    w=0 m=0
    [ "$(T capture-pane -p -J -S - -E - -t "$pane" | sed '/^$/d' | tail -1)" = 3000 ] && w=1
    [ "$(T display -p -t "$pane" '#{pane_path}')" = ltx-mark ] && m=1
    whole=$((whole + w)) marked=$((marked + m))
    [ "$m" = 1 ] && [ "$w" = 0 ] && wrong=$((wrong + 1))
    T kill-session -t =run
  done
  T kill-server
  echo "$whole $marked $wrong"
}

out=$(mktemp -d "${TMPDIR:-/tmp}/ltx-measure.XXXXXX")
trap 'rm -rf -- "${out:?}"' EXIT
for tmux in "$@"; do
  for shape in bare mark linger; do
    for p in 1 2 3; do probe "$tmux" "$shape" "$runs" "ltx-measure-$$-$p" >"$out/$p" & done
    wait
    cat "$out"/1 "$out"/2 "$out"/3 | awk -v t="$("$tmux" -V)" -v s="$shape" -v n=$((runs * 3)) \
      '{w += $1; m += $2; x += $3} END {printf "%s %s: whole %d of %d, mark shown %d, mark on a cut run %d\n", t, s, w, n, m, x}'
  done
done
