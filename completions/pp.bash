# bash completion for pp (pi-plus)
_pp() {
  local cur prev words cword
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  local commands="new n create up start down stop restart status ls list attach a logs log send mesh check validate doctor init install autostart uninstall version help"

  case "$prev" in
    -c|--config)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
    --socket|--lines|-n|--agent|-C|--dir)
      return 0
      ;;
    mesh)
      COMPREPLY=( $(compgen -W "ls list resolve send" -- "$cur") )
      return 0
      ;;
    attach|a|logs|log|send|down|stop|restart|up|start)
      local cfg="" i names=""
      for ((i = 1; i < COMP_CWORD; i++)); do
        if [[ "${COMP_WORDS[i]}" == "-c" || "${COMP_WORDS[i]}" == "--config" ]]; then
          cfg="${COMP_WORDS[i+1]}"
        fi
      done
      if [[ -n "$cfg" && -r "$cfg" ]]; then
        names=$(sed -n 's/^[[:space:]-]*name:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$cfg")
      fi
      if [[ "$prev" == "send" ]]; then
        COMPREPLY=( $(compgen -W "all broadcast $names" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "$names" -- "$cur") )
      fi
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--config --socket --json --dry-run --force --reconcile --quiet --verbose --lines --watch --print --path --no-enter --attach --log --save --no-remote-pi --dir --agent --as --wait --reply --no-wait --body-json --help --version" -- "$cur") )
    return 0
  fi
  if [[ $COMP_CWORD -eq 2 && "${COMP_WORDS[1]}" == "help" ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi
}
complete -F _pp pp pi-plus
