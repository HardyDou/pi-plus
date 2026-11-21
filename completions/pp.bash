# bash completion for pp (pi-plus)
_pp() {
  local cur prev words cword
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  local commands="tui panel back new n create up start down stop rm remove delete adopt role plan runbook why explain mv restart status ls list attach a logs log send mesh audit backup restore cron todo todos node nodes check clean validate doctor init install autostart uninstall alias link update upgrade version help"

  case "$prev" in
    -c|--config)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
    --socket|--lines|--idle-over|--sort|--cwd|-n|--agent|-C|--dir|--host|--port|--user|--identity|--password|--note|--tag|--timeout|--role|--node|--from|--password-env|--from-ssh-config|--base-path|--default-agent|--default-restart|--default-remote-pi-mode)
      return 0
      ;;
    --password-env|--from-ssh-config)
      return 0
      ;;
    mesh)
      COMPREPLY=( $(compgen -W "ls list resolve send inbox listen watch" -- "$cur") )
      return 0
      ;;
    backup)  opts="--list --keep --out --json --dry-run -c --socket" ;;
    restore) opts="--dry-run --force --out --json -c --socket" ;;
    audit)
      COMPREPLY=($(compgen -W "--limit --action --since --prune --file --json" -- "$cur"))
      return 0
      ;;
    cron)
      COMPREPLY=( $(compgen -W "add ls list rm remove delete run fire tick install uninstall status logs log reset" -- "$cur") )
      return 0
      ;;
    todo|todos)
      COMPREPLY=( $(compgen -W "ls list add done finish seen attach go rm remove delete clear prune" -- "$cur") )
      return 0
      ;;
    node|nodes)
      COMPREPLY=( $(compgen -W "ls list status show info describe add set upsert rm remove delete test ping probe check exec run drain undrain resume ssh" -- "$cur") )
      return 0
      ;;
    alias|link)
      COMPREPLY=( $(compgen -W "ls list add create link rm remove delete unlink" -- "$cur") )
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
    COMPREPLY=( $(compgen -W "--config --socket --json --dry-run --force --reconcile --quiet --verbose --lines --idle-over --sort --watch --print --path --no-enter --attach --log --save --no-remote-pi --dir --agent --as --wait --reply --no-wait --body-json --bin-dir --check --at --in --every --command --catch-up --start --via --now --heal --remote --drift --node --tag --parallel --actor --idle-over --sort --started --yes --role --sort --grep --context --ignore-case --limit --prune --since --action --base-path --default-agent --default-restart --default-remote-pi-mode --guard --no-guard --registry --once --brief --keep --stalls --help --version" -- "$cur") )
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
complete -F _pp pp pi-plus pifarm
