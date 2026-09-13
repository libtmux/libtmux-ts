import type { CommandCatalog, OptionReference } from "./reference.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fishQuote = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
interface Entry {
  keys: string[];
  kind: string;
  completion?: string | undefined;
  variadic?: boolean;
  choices?: string[];
  next?: number;
}
function entries(catalog: CommandCatalog): Entry[] {
  return catalog.commands.flatMap((command, node) => {
    const flags = (option: OptionReference) =>
      [option.short, option.long].filter((flag): flag is string => !!flag);
    return [
      ...command.options.map((option) => ({
        keys: flags(option).map((flag) => `${node}:${flag}`),
        kind: option.value,
        ...option,
      })),
      ...command.arguments.map((argument, index) => ({
        keys: [`${node}:@${index}`],
        kind: "argument",
        ...argument,
      })),
      ...command.subcommands.map((name) => ({
        keys: [`${node}:>${name}`],
        kind: "command",
        next: catalog.commands.findIndex(
          (candidate) => candidate.path.join(" ") === [...command.path, name].join(" "),
        ),
      })),
      { keys: [`${node}:flags`], kind: "flags", choices: command.options.flatMap(flags) },
      { keys: [`${node}:commands`], kind: "commands", choices: command.subcommands },
    ];
  });
}

function shScript(catalog: CommandCatalog, shell: "bash" | "zsh", name: string): string {
  const lookup = entries(catalog)
    .map(
      (entry) =>
        `    ${entry.keys.map(quote).join("|")}) kind=${quote(entry.kind)}; files=${quote(entry.completion ?? "")}; many=${entry.variadic ? 1 : 0}; next=${entry.next ?? -1}; candidates=(${(entry.choices ?? []).map(quote).join(" ")});;`,
    )
    .join("\n");
  const setup =
    shell === "bash"
      ? `local -a words=()
  local raw line=$COMP_LINE join_next=0 end=-1 index trim=
  for ((index=0; index<=COMP_CWORD; index++)); do
    raw=\${COMP_WORDS[index]}
    if [[ -n $raw && $raw != *[!=:]* ]]; then
      if [[ $end -lt 1 || $line == [[:blank:]]* ]]; then end=$((end + 1)); fi
      words[end]=\${words[end]}$raw
      line=\${line#*"$raw"}
      join_next=1
      [[ $line == [[:blank:]]* ]] && join_next=0
    else
      [[ $join_next == 1 ]] || end=$((end + 1))
      words[end]=\${words[end]}$raw
      line=\${line#*"$raw"}
      join_next=0
    fi
  done
  raw=\${COMP_WORDS[COMP_CWORD]}
  if [[ -n $raw && $raw != *[!=:]* ]]; then trim=\${words[end]}; else trim=\${words[end]%"$raw"}; fi
  COMPREPLY=()`
      : `setopt localoptions KSH_ARRAYS
  local -a words=("\${words[@]}")
  local end=$((CURRENT - 1))`;
  const emit =
    shell === "bash"
      ? `for candidate in "\${candidates[@]}"; do
    if [[ $candidate == "$cur"* ]]; then candidate=$prefix$candidate; COMPREPLY+=("\${candidate#"$trim"}"); fi
  done
  if [[ -n $files ]]; then
    local action=file
    [[ $files == directory ]] && action=directory
    while IFS= read -r candidate; do candidate=$prefix$candidate; COMPREPLY+=("\${candidate#"$trim"}"); done < <(compgen -A "$action" -- "$cur")
  fi`
      : `unsetopt KSH_ARRAYS
  if (( \${#candidates[@]} )); then compadd -p "$prefix" -- "\${candidates[@]}"; fi
  if [[ -n $files ]]; then
    [[ -z $prefix ]] || compset -P "$prefix"
    if [[ $files == directory ]]; then _files -/; else _files; fi
  fi`;
  return `${shell === "zsh" ? `#compdef ${catalog.program}\n` : "# Bash 3.2 or newer.\n"}${name}_lookup() {
  kind=; files=; many=0; next=-1; candidates=()
  case "$node:$1" in
${lookup}
  esac
}
${name}() {
  ${setup}
  local node=0 pos=0 stop=0 pending= kind= files= many=0 next=-1
  local w key tail prefix= cur candidate i
  local -a candidates=()
  for ((i=1; i<end; i++)); do
    w=\${words[i]}
    if [[ -n $pending ]]; then
      if [[ $pending == required || $w != -* || $w == - ]]; then
        [[ $many == 1 ]] && pending=optional || pending=
        continue
      fi
      pending=
    fi
    if [[ $stop == 0 && $w == -- ]]; then stop=1; continue; fi
    if [[ $stop == 0 && $w == --* ]]; then
      key=\${w%%=*}; ${name}_lookup "$key"
      if [[ $kind == required || $kind == optional ]]; then
        if [[ $w == *=* ]]; then [[ $many == 1 ]] && pending=optional; else pending=$kind; fi
      fi
      continue
    fi
    if [[ $stop == 0 && $w == -?* ]]; then
      tail=\${w#-}
      while [[ -n $tail ]]; do
        key=-\${tail:0:1}; tail=\${tail:1}; ${name}_lookup "$key"
        if [[ $kind == required || $kind == optional ]]; then
          if [[ -n $tail ]]; then [[ $many == 1 ]] && pending=optional; else pending=$kind; fi
          break
        fi
      done
      continue
    fi
    if [[ $stop == 0 && $pos == 0 ]]; then
      ${name}_lookup ">$w"
      if [[ $next -ge 0 ]]; then node=$next; pos=0; continue; fi
    fi
    ${name}_lookup "@$pos"
    [[ $many == 1 ]] || pos=$((pos + 1))
  done
  cur=\${words[end]}
  if [[ $pending == optional && $cur == -?* ]]; then pending=; fi
  if [[ -z $pending && $stop == 0 && $cur == --*=* ]]; then
    key=\${cur%%=*}; ${name}_lookup "$key"
    if [[ $kind == required || $kind == optional ]]; then prefix=$key=; cur=\${cur#*=}; pending=$kind; fi
  elif [[ -z $pending && $stop == 0 && $cur == -?* && $cur != --* ]]; then
    tail=\${cur#-}; prefix=-
    while [[ -n $tail ]]; do
      key=-\${tail:0:1}; prefix=$prefix\${tail:0:1}; tail=\${tail:1}; ${name}_lookup "$key"
      if [[ $kind == required || $kind == optional ]]; then cur=$tail; pending=$kind; break; fi
    done
    [[ -n $pending ]] || prefix=
  fi
  if [[ -z $pending ]]; then
    if [[ $stop == 0 && $cur == -* ]]; then
      ${name}_lookup flags
    else
      ${name}_lookup "@$pos"
      if [[ $stop == 0 && $pos == 0 ]]; then
        local -a positional=("\${candidates[@]}")
        local positional_files=$files
        ${name}_lookup commands
        candidates+=("\${positional[@]}"); files=$positional_files
      fi
    fi
  fi
  ${emit}
  return 0
}
${shell === "bash" ? `complete -o filenames -F ${name} ${quote(catalog.program)}` : `compdef ${name} ${quote(catalog.program)}\nif [[ \${funcstack[1]} == ${quote("_" + catalog.program)} ]]; then ${name}; fi`}
`;
}

function fishScript(catalog: CommandCatalog, name: string): string {
  const lookup = entries(catalog)
    .map(
      (entry) =>
        `    case ${entry.keys.map(fishQuote).join(" ")}\n      printf '%s\\n' ${[entry.kind, entry.completion ?? "_", entry.variadic ? "1" : "0", String(entry.next ?? -1), ...(entry.choices ?? [])].map(fishQuote).join(" ")}`,
    )
    .join("\n");
  return `function ${name}_lookup
  switch "$argv[1]:$argv[2]"
${lookup}
    case '*'
      printf '%s\\n' _ _ 0 -1
  end
end
function ${name}
  set -l words (commandline -opc)
  set -l cur (string unescape -- (commandline -ct))
  set -l node 0
  set -l pos 0
  set -l stop 0
  set -l pending
  set -l info _ _ 0 -1
  set -l prefix ''
  for w in $words[2..-1]
    if test -n "$pending"
      if test "$pending" = required; or not string match -rq -- '^-.' "$w"
        set pending
        if test "$info[3]" = 1; set pending optional; end
        continue
      end
      set pending
    end
    if test $stop = 0; and test "$w" = --
      set stop 1
      continue
    end
    if test $stop = 0; and string match -q -- '--*' "$w"
      set -l key (string split -m 1 = -- "$w")[1]
      set info (${name}_lookup $node "$key")
      if contains -- "$info[1]" required optional
        if string match -q '*=*' -- "$w"
          if test "$info[3]" = 1; set pending optional; end
        else
          set pending $info[1]
        end
      end
      continue
    end
    if test $stop = 0; and string match -rq -- '^-.' "$w"
      set -l tail (string sub -s 2 -- "$w")
      while test -n "$tail"
        set -l key -(string sub -l 1 -- "$tail")
        set tail (string sub -s 2 -- "$tail")
        set info (${name}_lookup $node "$key")
        if contains -- "$info[1]" required optional
          if test -n "$tail"
            if test "$info[3]" = 1; set pending optional; end
          else
            set pending $info[1]
          end
          break
        end
      end
      continue
    end
    if test $stop = 0; and test $pos = 0
      set info (${name}_lookup $node ">$w")
      if test "$info[4]" -ge 0
        set node $info[4]
        set pos 0
        continue
      end
    end
    set info (${name}_lookup $node "@$pos")
    if test "$info[3]" != 1; set pos (math $pos + 1); end
  end
  if test "$pending" = optional; and string match -rq -- '^-.' "$cur"; set pending; end
  if test -z "$pending"; and test $stop = 0; and string match -q -- '--*=*' "$cur"
    set -l parts (string split -m 1 = -- "$cur")
    set info (${name}_lookup $node "$parts[1]")
    if contains -- "$info[1]" required optional
      set prefix "$parts[1]="
      set cur "$parts[2]"
      set pending $info[1]
    end
  else if test -z "$pending"; and test $stop = 0; and string match -rq -- '^-.' "$cur"; and not string match -q -- '--*' "$cur"
    set -l tail (string sub -s 2 -- "$cur")
    set prefix -
    while test -n "$tail"
      set -l char (string sub -l 1 -- "$tail")
      set prefix "$prefix$char"
      set tail (string sub -s 2 -- "$tail")
      set info (${name}_lookup $node "-$char")
      if contains -- "$info[1]" required optional
        set cur "$tail"
        set pending $info[1]
        break
      end
    end
    if test -z "$pending"; set prefix ''; end
  end
  if test -z "$pending"
    if test $stop = 0; and string match -q -- '-*' "$cur"
      set info (${name}_lookup $node flags)
    else
      set info (${name}_lookup $node "@$pos")
      if test $stop = 0; and test $pos = 0
        set -l children (${name}_lookup $node commands)
        set -a info $children[5..-1]
      end
    end
  end
  for candidate in $info[5..-1]
    if test (string sub -l (string length -- "$cur") -- "$candidate") = "$cur"
      printf '%s\\n' "$prefix$candidate"
    end
  end
  if contains -- "$info[2]" file directory
    set -l paths (__fish_complete_path (string escape -- "$cur"))
    for path in $paths
      set -l value (string split -m 1 \\t -- "$path")[1]
      if test "$info[2]" = file; or string match -q '*/' -- "$value"
        printf '%s\\n' "$prefix$value"
      end
    end
  end
end
complete -c ${fishQuote(catalog.program)} -f -a '(${name})'
`;
}

export function completionScript(catalog: CommandCatalog, shell: "bash" | "zsh" | "fish"): string {
  const name = `_${catalog.program.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
  return shell === "fish" ? fishScript(catalog, name) : shScript(catalog, shell, name);
}
