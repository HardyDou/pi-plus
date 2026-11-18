export const EXAMPLE_CONFIG = `# pi-farm — declarative tmux farm for pi agents
# Docs: https://github.com/HardyDou/pi-farm
version: 1

# Optional: run every session on a dedicated tmux socket (default: tmux's own).
# tmux:
#   socket: pi-farm

defaults:
  # Agent command. When this resolves to "pi", pi-farm adds the pi session
  # flags below; any other command runs untouched.
  agent: pi
  # Extra argv appended to the agent command, e.g. ["--approve"].
  args: []
  # Environment merged into every session.
  env: {}

sessions:
  # One name drives everything: tmux session, pi session display name and
  # remote-pi mesh name. Override any of them when they need to differ.
  - name: backend
    cwd: ~/code/backend

  # Resume a specific pi session (id or .jsonl path); omit to start fresh.
  # pi_session: 1a2b3c4d
  #
  # - name: docs
  #   cwd: ~/code/docs
  #   pi_session: 1a2b3c4d
  #   pi_session_name: docs        # default: session name
  #   remote_pi_name: docs         # default: session name
  #   remote_pi_mode: config       # config | env | off

  # A non-pi agent gets no pi flags.
  # - name: shell
  #   cwd: ~/code/backend
  #   agent: bash
`;
