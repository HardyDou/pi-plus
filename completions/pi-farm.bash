# bash completion for pi-farm
_pi_farm() {
  local cur prev words cword
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  local commands="up down restart status attach logs send check doctor init install uninstall version help"

  case "$prev" in
    -c|--config)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
    --socket|--lines|-n)
      return 0
      ;;
    attach|logs|send|down|restart)
      local cfg="" i
      for ((i = 1; i < COMP_CWORD; i++)); do
        if [[ "${COMP_WORDS[i]}" == "-c" || "${COMP_WORDS[i]}" == "--config" ]]; then
          cfg="${COMP_WORDS[i+1]}"
        fi
      done
      if [[ -n "$cfg" && -r "$cfg" ]]; then
        COMPREPLY=( $(compgen -W "$(sed -n 's/^[[:space:]-]*name:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$cfg")" -- "$cur") )
      fi
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--config --socket --json --dry-run --force --quiet --verbose --lines --watch --print --help --version" -- "$cur") )
    return 0
  fi
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi
}
complete -F _pi_farm pi-farm
