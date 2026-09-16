function _tmux_workspace_lookup
  switch "$argv[1]:$argv[2]"
    case '0:-V' '0:--version'
      printf '%s\n' 'none' '_' '0' '-1'
    case '0:--log-level'
      printf '%s\n' 'required' '_' '0' '-1' 'debug' 'info' 'warning' 'error' 'critical'
    case '0:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '0:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '0:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '0:-h' '0:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '0:>load'
      printf '%s\n' 'command' '_' '0' '1'
    case '0:>shell'
      printf '%s\n' 'command' '_' '0' '2'
    case '0:>import'
      printf '%s\n' 'command' '_' '0' '3'
    case '0:>convert'
      printf '%s\n' 'command' '_' '0' '6'
    case '0:>debug-info'
      printf '%s\n' 'command' '_' '0' '7'
    case '0:>ls'
      printf '%s\n' 'command' '_' '0' '8'
    case '0:>search'
      printf '%s\n' 'command' '_' '0' '9'
    case '0:>edit'
      printf '%s\n' 'command' '_' '0' '10'
    case '0:>freeze'
      printf '%s\n' 'command' '_' '0' '11'
    case '0:>completion'
      printf '%s\n' 'command' '_' '0' '12'
    case '0:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '-V' '--version' '--log-level' '--color' '--json' '--ndjson' '-h' '--help'
    case '0:commands'
      printf '%s\n' 'commands' '_' '0' '-1' 'load' 'shell' 'import' 'convert' 'debug-info' 'ls' 'search' 'edit' 'freeze' 'completion'
    case '1:-L'
      printf '%s\n' 'required' '_' '0' '-1'
    case '1:-S'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '1:-f'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '1:-s'
      printf '%s\n' 'required' '_' '0' '-1'
    case '1:-y' '1:--yes'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:-d'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:-a' '1:--append'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:-2'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:-8'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:--log-file'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '1:--progress-format'
      printf '%s\n' 'required' '_' '0' '-1'
    case '1:--progress-lines'
      printf '%s\n' 'required' '_' '0' '-1'
    case '1:--no-progress'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '1:-h' '1:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '1:@0'
      printf '%s\n' 'argument' 'file' '1' '-1'
    case '1:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '-L' '-S' '-f' '-s' '-y' '--yes' '-d' '-a' '--append' '-2' '-8' '--log-file' '--progress-format' '--progress-lines' '--no-progress' '--json' '--ndjson' '--color' '-h' '--help'
    case '1:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '2:-S'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '2:-L'
      printf '%s\n' 'required' '_' '0' '-1'
    case '2:-c'
      printf '%s\n' 'required' '_' '0' '-1'
    case '2:--best'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--pdb'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--code'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--ptipython'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--ptpython'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--ipython'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--bpython'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--use-pythonrc'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--no-startup'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--use-vi-mode'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--no-vi-mode'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '2:-h' '2:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '2:@0'
      printf '%s\n' 'argument' '_' '0' '-1'
    case '2:@1'
      printf '%s\n' 'argument' '_' '0' '-1'
    case '2:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '-S' '-L' '-c' '--best' '--pdb' '--code' '--ptipython' '--ptpython' '--ipython' '--bpython' '--use-pythonrc' '--no-startup' '--use-vi-mode' '--no-vi-mode' '--json' '--ndjson' '--color' '-h' '--help'
    case '2:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '3:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '3:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '3:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '3:-h' '3:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '3:>teamocil'
      printf '%s\n' 'command' '_' '0' '4'
    case '3:>tmuxinator'
      printf '%s\n' 'command' '_' '0' '5'
    case '3:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--json' '--ndjson' '--color' '-h' '--help'
    case '3:commands'
      printf '%s\n' 'commands' '_' '0' '-1' 'teamocil' 'tmuxinator'
    case '4:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '4:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '4:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '4:--save-to'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '4:--workspace-format'
      printf '%s\n' 'required' '_' '0' '-1' 'yaml' 'json'
    case '4:--force'
      printf '%s\n' 'none' '_' '0' '-1'
    case '4:-h' '4:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '4:@0'
      printf '%s\n' 'argument' 'file' '0' '-1'
    case '4:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--json' '--ndjson' '--color' '--save-to' '--workspace-format' '--force' '-h' '--help'
    case '4:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '5:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '5:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '5:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '5:--save-to'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '5:--workspace-format'
      printf '%s\n' 'required' '_' '0' '-1' 'yaml' 'json'
    case '5:--force'
      printf '%s\n' 'none' '_' '0' '-1'
    case '5:-h' '5:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '5:@0'
      printf '%s\n' 'argument' 'file' '0' '-1'
    case '5:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--json' '--ndjson' '--color' '--save-to' '--workspace-format' '--force' '-h' '--help'
    case '5:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '6:-y' '6:--yes'
      printf '%s\n' 'none' '_' '0' '-1'
    case '6:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '6:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '6:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '6:--save-to'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '6:--workspace-format'
      printf '%s\n' 'required' '_' '0' '-1' 'yaml' 'json'
    case '6:--force'
      printf '%s\n' 'none' '_' '0' '-1'
    case '6:-h' '6:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '6:@0'
      printf '%s\n' 'argument' 'file' '0' '-1'
    case '6:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '-y' '--yes' '--json' '--ndjson' '--color' '--save-to' '--workspace-format' '--force' '-h' '--help'
    case '6:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '7:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '7:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '7:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '7:-h' '7:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '7:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--json' '--ndjson' '--color' '-h' '--help'
    case '7:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '8:--tree'
      printf '%s\n' 'none' '_' '0' '-1'
    case '8:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '8:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '8:--full'
      printf '%s\n' 'none' '_' '0' '-1'
    case '8:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '8:-h' '8:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '8:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--tree' '--json' '--ndjson' '--full' '--color' '-h' '--help'
    case '8:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '9:-f' '9:--field'
      printf '%s\n' 'required' '_' '0' '-1'
    case '9:-i' '9:--ignore-case'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:-S' '9:--smart-case'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:-F' '9:--fixed-strings'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:-w' '9:--word-regexp'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:-v' '9:--invert-match'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:--any'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '9:-h' '9:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '9:@0'
      printf '%s\n' 'argument' '_' '1' '-1'
    case '9:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '-f' '--field' '-i' '--ignore-case' '-S' '--smart-case' '-F' '--fixed-strings' '-w' '--word-regexp' '-v' '--invert-match' '--any' '--json' '--ndjson' '--color' '-h' '--help'
    case '9:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '10:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '10:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '10:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '10:-h' '10:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '10:@0'
      printf '%s\n' 'argument' 'file' '0' '-1'
    case '10:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--json' '--ndjson' '--color' '-h' '--help'
    case '10:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '11:-S'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '11:-L'
      printf '%s\n' 'required' '_' '0' '-1'
    case '11:-f' '11:--workspace-format'
      printf '%s\n' 'required' '_' '0' '-1' 'yaml' 'json'
    case '11:-o' '11:--save-to'
      printf '%s\n' 'required' 'file' '0' '-1'
    case '11:-y' '11:--yes'
      printf '%s\n' 'none' '_' '0' '-1'
    case '11:-q' '11:--quiet'
      printf '%s\n' 'none' '_' '0' '-1'
    case '11:--force'
      printf '%s\n' 'none' '_' '0' '-1'
    case '11:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '11:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '11:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '11:-h' '11:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '11:@0'
      printf '%s\n' 'argument' '_' '0' '-1'
    case '11:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '-S' '-L' '-f' '--workspace-format' '-o' '--save-to' '-y' '--yes' '-q' '--quiet' '--force' '--json' '--ndjson' '--color' '-h' '--help'
    case '11:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '12:--json'
      printf '%s\n' 'none' '_' '0' '-1'
    case '12:--ndjson'
      printf '%s\n' 'none' '_' '0' '-1'
    case '12:--color'
      printf '%s\n' 'required' '_' '0' '-1' 'auto' 'always' 'never'
    case '12:-h' '12:--help'
      printf '%s\n' 'none' '_' '0' '-1'
    case '12:@0'
      printf '%s\n' 'argument' '_' '0' '-1' 'bash' 'zsh' 'fish'
    case '12:flags'
      printf '%s\n' 'flags' '_' '0' '-1' '--json' '--ndjson' '--color' '-h' '--help'
    case '12:commands'
      printf '%s\n' 'commands' '_' '0' '-1'
    case '*'
      printf '%s\n' _ _ 0 -1
  end
end
function _tmux_workspace
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
      set info (_tmux_workspace_lookup $node "$key")
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
        set info (_tmux_workspace_lookup $node "$key")
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
      set info (_tmux_workspace_lookup $node ">$w")
      if test "$info[4]" -ge 0
        set node $info[4]
        set pos 0
        continue
      end
    end
    set info (_tmux_workspace_lookup $node "@$pos")
    if test "$info[3]" != 1; set pos (math $pos + 1); end
  end
  if test "$pending" = optional; and string match -rq -- '^-.' "$cur"; set pending; end
  if test -z "$pending"; and test $stop = 0; and string match -q -- '--*=*' "$cur"
    set -l parts (string split -m 1 = -- "$cur")
    set info (_tmux_workspace_lookup $node "$parts[1]")
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
      set info (_tmux_workspace_lookup $node "-$char")
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
      set info (_tmux_workspace_lookup $node flags)
    else
      set info (_tmux_workspace_lookup $node "@$pos")
      if test $stop = 0; and test $pos = 0
        set -l children (_tmux_workspace_lookup $node commands)
        set -a info $children[5..-1]
      end
    end
  end
  for candidate in $info[5..-1]
    if test (string sub -l (string length -- "$cur") -- "$candidate") = "$cur"
      printf '%s\n' "$prefix$candidate"
    end
  end
  if contains -- "$info[2]" file directory
    set -l paths (__fish_complete_path (string escape -- "$cur"))
    for path in $paths
      set -l value (string split -m 1 \t -- "$path")[1]
      if test "$info[2]" = file; or string match -q '*/' -- "$value"
        printf '%s\n' "$prefix$value"
      end
    end
  end
end
complete -c 'tmux-workspace' -f -a '(_tmux_workspace)'
