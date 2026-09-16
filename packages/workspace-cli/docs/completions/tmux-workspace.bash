# Bash 3.2 or newer.
_tmux_workspace_lookup() {
  kind=; files=; many=0; next=-1; candidates=()
  case "$node:$1" in
    '0:-V'|'0:--version') kind='none'; files=''; many=0; next=-1; candidates=();;
    '0:--log-level') kind='required'; files=''; many=0; next=-1; candidates=('debug' 'info' 'warning' 'error' 'critical');;
    '0:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '0:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '0:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '0:-h'|'0:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '0:>load') kind='command'; files=''; many=0; next=1; candidates=();;
    '0:>shell') kind='command'; files=''; many=0; next=2; candidates=();;
    '0:>import') kind='command'; files=''; many=0; next=3; candidates=();;
    '0:>convert') kind='command'; files=''; many=0; next=6; candidates=();;
    '0:>debug-info') kind='command'; files=''; many=0; next=7; candidates=();;
    '0:>ls') kind='command'; files=''; many=0; next=8; candidates=();;
    '0:>search') kind='command'; files=''; many=0; next=9; candidates=();;
    '0:>edit') kind='command'; files=''; many=0; next=10; candidates=();;
    '0:>freeze') kind='command'; files=''; many=0; next=11; candidates=();;
    '0:>completion') kind='command'; files=''; many=0; next=12; candidates=();;
    '0:flags') kind='flags'; files=''; many=0; next=-1; candidates=('-V' '--version' '--log-level' '--color' '--json' '--ndjson' '-h' '--help');;
    '0:commands') kind='commands'; files=''; many=0; next=-1; candidates=('load' 'shell' 'import' 'convert' 'debug-info' 'ls' 'search' 'edit' 'freeze' 'completion');;
    '1:-L') kind='required'; files=''; many=0; next=-1; candidates=();;
    '1:-S') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '1:-f') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '1:-s') kind='required'; files=''; many=0; next=-1; candidates=();;
    '1:-y'|'1:--yes') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:-d') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:-a'|'1:--append') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:-2') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:-8') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:--log-file') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '1:--progress-format') kind='required'; files=''; many=0; next=-1; candidates=();;
    '1:--progress-lines') kind='required'; files=''; many=0; next=-1; candidates=();;
    '1:--no-progress') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '1:-h'|'1:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '1:@0') kind='argument'; files='file'; many=1; next=-1; candidates=();;
    '1:flags') kind='flags'; files=''; many=0; next=-1; candidates=('-L' '-S' '-f' '-s' '-y' '--yes' '-d' '-a' '--append' '-2' '-8' '--log-file' '--progress-format' '--progress-lines' '--no-progress' '--json' '--ndjson' '--color' '-h' '--help');;
    '1:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '2:-S') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '2:-L') kind='required'; files=''; many=0; next=-1; candidates=();;
    '2:-c') kind='required'; files=''; many=0; next=-1; candidates=();;
    '2:--best') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--pdb') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--code') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--ptipython') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--ptpython') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--ipython') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--bpython') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--use-pythonrc') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--no-startup') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--use-vi-mode') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--no-vi-mode') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '2:-h'|'2:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '2:@0') kind='argument'; files=''; many=0; next=-1; candidates=();;
    '2:@1') kind='argument'; files=''; many=0; next=-1; candidates=();;
    '2:flags') kind='flags'; files=''; many=0; next=-1; candidates=('-S' '-L' '-c' '--best' '--pdb' '--code' '--ptipython' '--ptpython' '--ipython' '--bpython' '--use-pythonrc' '--no-startup' '--use-vi-mode' '--no-vi-mode' '--json' '--ndjson' '--color' '-h' '--help');;
    '2:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '3:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '3:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '3:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '3:-h'|'3:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '3:>teamocil') kind='command'; files=''; many=0; next=4; candidates=();;
    '3:>tmuxinator') kind='command'; files=''; many=0; next=5; candidates=();;
    '3:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--json' '--ndjson' '--color' '-h' '--help');;
    '3:commands') kind='commands'; files=''; many=0; next=-1; candidates=('teamocil' 'tmuxinator');;
    '4:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '4:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '4:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '4:--save-to') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '4:--workspace-format') kind='required'; files=''; many=0; next=-1; candidates=('yaml' 'json');;
    '4:--force') kind='none'; files=''; many=0; next=-1; candidates=();;
    '4:-h'|'4:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '4:@0') kind='argument'; files='file'; many=0; next=-1; candidates=();;
    '4:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--json' '--ndjson' '--color' '--save-to' '--workspace-format' '--force' '-h' '--help');;
    '4:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '5:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '5:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '5:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '5:--save-to') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '5:--workspace-format') kind='required'; files=''; many=0; next=-1; candidates=('yaml' 'json');;
    '5:--force') kind='none'; files=''; many=0; next=-1; candidates=();;
    '5:-h'|'5:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '5:@0') kind='argument'; files='file'; many=0; next=-1; candidates=();;
    '5:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--json' '--ndjson' '--color' '--save-to' '--workspace-format' '--force' '-h' '--help');;
    '5:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '6:-y'|'6:--yes') kind='none'; files=''; many=0; next=-1; candidates=();;
    '6:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '6:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '6:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '6:--save-to') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '6:--workspace-format') kind='required'; files=''; many=0; next=-1; candidates=('yaml' 'json');;
    '6:--force') kind='none'; files=''; many=0; next=-1; candidates=();;
    '6:-h'|'6:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '6:@0') kind='argument'; files='file'; many=0; next=-1; candidates=();;
    '6:flags') kind='flags'; files=''; many=0; next=-1; candidates=('-y' '--yes' '--json' '--ndjson' '--color' '--save-to' '--workspace-format' '--force' '-h' '--help');;
    '6:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '7:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '7:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '7:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '7:-h'|'7:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '7:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--json' '--ndjson' '--color' '-h' '--help');;
    '7:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '8:--tree') kind='none'; files=''; many=0; next=-1; candidates=();;
    '8:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '8:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '8:--full') kind='none'; files=''; many=0; next=-1; candidates=();;
    '8:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '8:-h'|'8:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '8:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--tree' '--json' '--ndjson' '--full' '--color' '-h' '--help');;
    '8:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '9:-f'|'9:--field') kind='required'; files=''; many=0; next=-1; candidates=();;
    '9:-i'|'9:--ignore-case') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:-S'|'9:--smart-case') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:-F'|'9:--fixed-strings') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:-w'|'9:--word-regexp') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:-v'|'9:--invert-match') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:--any') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '9:-h'|'9:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '9:@0') kind='argument'; files=''; many=1; next=-1; candidates=();;
    '9:flags') kind='flags'; files=''; many=0; next=-1; candidates=('-f' '--field' '-i' '--ignore-case' '-S' '--smart-case' '-F' '--fixed-strings' '-w' '--word-regexp' '-v' '--invert-match' '--any' '--json' '--ndjson' '--color' '-h' '--help');;
    '9:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '10:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '10:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '10:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '10:-h'|'10:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '10:@0') kind='argument'; files='file'; many=0; next=-1; candidates=();;
    '10:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--json' '--ndjson' '--color' '-h' '--help');;
    '10:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '11:-S') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '11:-L') kind='required'; files=''; many=0; next=-1; candidates=();;
    '11:-f'|'11:--workspace-format') kind='required'; files=''; many=0; next=-1; candidates=('yaml' 'json');;
    '11:-o'|'11:--save-to') kind='required'; files='file'; many=0; next=-1; candidates=();;
    '11:-y'|'11:--yes') kind='none'; files=''; many=0; next=-1; candidates=();;
    '11:-q'|'11:--quiet') kind='none'; files=''; many=0; next=-1; candidates=();;
    '11:--force') kind='none'; files=''; many=0; next=-1; candidates=();;
    '11:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '11:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '11:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '11:-h'|'11:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '11:@0') kind='argument'; files=''; many=0; next=-1; candidates=();;
    '11:flags') kind='flags'; files=''; many=0; next=-1; candidates=('-S' '-L' '-f' '--workspace-format' '-o' '--save-to' '-y' '--yes' '-q' '--quiet' '--force' '--json' '--ndjson' '--color' '-h' '--help');;
    '11:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
    '12:--json') kind='none'; files=''; many=0; next=-1; candidates=();;
    '12:--ndjson') kind='none'; files=''; many=0; next=-1; candidates=();;
    '12:--color') kind='required'; files=''; many=0; next=-1; candidates=('auto' 'always' 'never');;
    '12:-h'|'12:--help') kind='none'; files=''; many=0; next=-1; candidates=();;
    '12:@0') kind='argument'; files=''; many=0; next=-1; candidates=('bash' 'zsh' 'fish');;
    '12:flags') kind='flags'; files=''; many=0; next=-1; candidates=('--json' '--ndjson' '--color' '-h' '--help');;
    '12:commands') kind='commands'; files=''; many=0; next=-1; candidates=();;
  esac
}
_tmux_workspace() {
  local -a words=()
  local raw line=$COMP_LINE join_next=0 end=-1 index trim=
  for ((index=0; index<=COMP_CWORD; index++)); do
    raw=${COMP_WORDS[index]}
    if [[ -n $raw && $raw != *[!=:]* ]]; then
      if [[ $end -lt 1 || $line == [[:blank:]]* ]]; then end=$((end + 1)); fi
      words[end]=${words[end]}$raw
      line=${line#*"$raw"}
      join_next=1
      [[ $line == [[:blank:]]* ]] && join_next=0
    else
      [[ $join_next == 1 ]] || end=$((end + 1))
      words[end]=${words[end]}$raw
      line=${line#*"$raw"}
      join_next=0
    fi
  done
  raw=${COMP_WORDS[COMP_CWORD]}
  if [[ -n $raw && $raw != *[!=:]* ]]; then trim=${words[end]}; else trim=${words[end]%"$raw"}; fi
  COMPREPLY=()
  local node=0 pos=0 stop=0 pending= kind= files= many=0 next=-1
  local w key tail prefix= cur candidate i
  local -a candidates=()
  for ((i=1; i<end; i++)); do
    w=${words[i]}
    if [[ -n $pending ]]; then
      if [[ $pending == required || $w != -* || $w == - ]]; then
        [[ $many == 1 ]] && pending=optional || pending=
        continue
      fi
      pending=
    fi
    if [[ $stop == 0 && $w == -- ]]; then stop=1; continue; fi
    if [[ $stop == 0 && $w == --* ]]; then
      key=${w%%=*}; _tmux_workspace_lookup "$key"
      if [[ $kind == required || $kind == optional ]]; then
        if [[ $w == *=* ]]; then [[ $many == 1 ]] && pending=optional; else pending=$kind; fi
      fi
      continue
    fi
    if [[ $stop == 0 && $w == -?* ]]; then
      tail=${w#-}
      while [[ -n $tail ]]; do
        key=-${tail:0:1}; tail=${tail:1}; _tmux_workspace_lookup "$key"
        if [[ $kind == required || $kind == optional ]]; then
          if [[ -n $tail ]]; then [[ $many == 1 ]] && pending=optional; else pending=$kind; fi
          break
        fi
      done
      continue
    fi
    if [[ $stop == 0 && $pos == 0 ]]; then
      _tmux_workspace_lookup ">$w"
      if [[ $next -ge 0 ]]; then node=$next; pos=0; continue; fi
    fi
    _tmux_workspace_lookup "@$pos"
    [[ $many == 1 ]] || pos=$((pos + 1))
  done
  cur=${words[end]}
  if [[ $pending == optional && $cur == -?* ]]; then pending=; fi
  if [[ -z $pending && $stop == 0 && $cur == --*=* ]]; then
    key=${cur%%=*}; _tmux_workspace_lookup "$key"
    if [[ $kind == required || $kind == optional ]]; then prefix=$key=; cur=${cur#*=}; pending=$kind; fi
  elif [[ -z $pending && $stop == 0 && $cur == -?* && $cur != --* ]]; then
    tail=${cur#-}; prefix=-
    while [[ -n $tail ]]; do
      key=-${tail:0:1}; prefix=$prefix${tail:0:1}; tail=${tail:1}; _tmux_workspace_lookup "$key"
      if [[ $kind == required || $kind == optional ]]; then cur=$tail; pending=$kind; break; fi
    done
    [[ -n $pending ]] || prefix=
  fi
  if [[ -z $pending ]]; then
    if [[ $stop == 0 && $cur == -* ]]; then
      _tmux_workspace_lookup flags
    else
      _tmux_workspace_lookup "@$pos"
      if [[ $stop == 0 && $pos == 0 ]]; then
        local -a positional=("${candidates[@]}")
        local positional_files=$files
        _tmux_workspace_lookup commands
        candidates+=("${positional[@]}"); files=$positional_files
      fi
    fi
  fi
  for candidate in "${candidates[@]}"; do
    if [[ $candidate == "$cur"* ]]; then candidate=$prefix$candidate; COMPREPLY+=("${candidate#"$trim"}"); fi
  done
  if [[ -n $files ]]; then
    local action=file
    [[ $files == directory ]] && action=directory
    while IFS= read -r candidate; do candidate=$prefix$candidate; COMPREPLY+=("${candidate#"$trim"}"); done < <(compgen -A "$action" -- "$cur")
  fi
  return 0
}
complete -o filenames -F _tmux_workspace 'tmux-workspace'
