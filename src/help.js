// Single source of truth for `pi-farm help` — the overview, per-command pages and
// the shell completion word list are all generated from COMMANDS.

export const RESTART_POLICIES_HELP = [
  "  no               never started by a bare `up`, autostart or `--watch`",
  "  always           started, and brought back when it dies (default)",
  "  on-failure       like always, but a manual `down` is remembered",
  "  unless-stopped   like always, but a manual `down` is remembered",
].join("\n");

export const COMMANDS = [
  {
    name: "up",
    aliases: ["start"],
    summary: "Create/start configured sessions, detached (default: all)",
    usage: "pi-farm up [names...] [options]",
    details: [
      "Starts each session in a detached tmux session whose name is `tmux_name`",
      "(defaults to `name`) with the working directory `cwd`.",
      "",
      "With no names, every session whose restart policy is not `no` is started;",
      "sessions stopped by hand are skipped when `--reconcile` is given.",
      "Sessions that are already running are left alone unless `--force` is used.",
    ].join("\n"),
    options: [
      "--force          recreate the session even if it is already running",
      "--reconcile      autostart/watch mode: skip sessions stopped by hand",
      "--dry-run        print the tmux command instead of running it",
      "--json           JSON output",
    ],
    examples: ["pi-farm up", "pi-farm up backend", "pi-farm up backend --force", "pi-farm up --dry-run -v"],
    see: ["status", "restart", "attach"],
  },
  {
    name: "down",
    aliases: ["stop"],
    summary: "Stop sessions",
    usage: "pi-farm down [names...] [options]",
    details: [
      "Stops tmux sessions (and everything running inside them).",
      "With no names every configured session is stopped, whatever its policy.",
      "",
      "For `unless-stopped` and `on-failure` a manual stop is remembered, so",
      "autostart and `--watch` will not bring the session back. `up <name>`",
      "clears that record again.",
    ].join("\n"),
    options: ["--dry-run        print what would be stopped", "--json           JSON output"],
    examples: ["pi-farm down backend", "pi-farm down", "pi-farm down backend docs"],
    see: ["up", "restart", "status"],
  },
  {
    name: "restart",
    summary: "Restart sessions (kill + up)",
    usage: "pi-farm restart [names...] [options]",
    details: [
      "Equivalent to `down <names>` followed by `up <names>`, including the",
      "`--force` behaviour. Sessions with `restart: no` are skipped when no name",
      "is given, and are restarted when named explicitly.",
    ].join("\n"),
    options: ["--dry-run        print the tmux commands instead of running them", "--json           JSON output"],
    examples: ["pi-farm restart backend", "pi-farm restart"],
    see: ["up", "down"],
  },
  {
    name: "status",
    aliases: ["ls", "list"],
    summary: "Show config, tmux state, pi session and remote-pi name",
    usage: "pi-farm status [names...] [options]",
    details: [
      "Prints one row per configured session: tmux name, state, restart policy,",
      "pid, agent, cwd, pi session and remote-pi name.",
      "",
      "States: running, attached, dead (pane alive but the agent exited),",
      "stopped, off (never auto-started or stopped by hand).",
    ].join("\n"),
    options: ["--json           machine-readable JSON", "-q, --quiet      only the table, no summary line"],
    examples: ["pi-farm status", "pi-farm status backend", "pi-farm status --json"],
    see: ["logs", "doctor"],
  },
  {
    name: "attach",
    aliases: ["a"],
    summary: "Attach to a session (starts it if missing)",
    usage: "pi-farm attach <name> [options]",
    details: [
      "Attaches the current terminal to the tmux session. If the session does not",
      "exist it is started first. Detach with `Ctrl-b d` — the agent keeps running.",
    ].join("\n"),
    options: ["--dry-run        print the tmux command instead of attaching"],
    examples: ["pi-farm attach backend", "pi-farm a backend"],
    see: ["up", "status"],
  },
  {
    name: "logs",
    aliases: ["log"],
    summary: "Print recent pane output (--lines N, default 200)",
    usage: "pi-farm logs <name> [options]",
    details: [
      "Dumps the tail of the tmux pane, so you can see what the agent printed",
      "without attaching. Use `log:` in the config to keep the full output in a",
      "file via `pipe-pane`.",
    ].join("\n"),
    options: ["-n, --lines <n>  how many scrollback lines (default 200)"],
    examples: ["pi-farm logs backend", "pi-farm logs backend -n 1000"],
    see: ["send", "status"],
  },
  {
    name: "send",
    summary: 'Type text into the pane and press Enter (--no-enter)',
    usage: 'pi-farm send <name> "text" [options]',
    details: [
      "Sends keystrokes to the session's pane and presses Enter, which is handy",
      "for pushing a prompt into a running agent from another shell or a script.",
    ].join("\n"),
    options: ["--no-enter       do not press Enter after the text"],
    examples: ['pi-farm send backend "run the tests"', 'pi-farm send backend "yes" --no-enter'],
    see: ["logs", "attach"],
  },
  {
    name: "check",
    aliases: ["validate"],
    summary: "Validate the config without touching tmux",
    usage: "pi-farm check [options]",
    details: [
      "Parses the config, expands paths and prints a per-session summary of what",
      "would be started, plus warnings (shared cwd, disabled sessions, ...).",
      "Safe to run in CI.",
    ].join("\n"),
    options: ["--json           JSON output"],
    examples: ["pi-farm check", "pi-farm check -c ./pi-farm.yml --json"],
    see: ["doctor", "init"],
  },
  {
    name: "doctor",
    summary: "Environment + config diagnostics",
    usage: "pi-farm doctor [options]",
    details: [
      "Checks node, tmux, pi, the config file, the remote-pi plugin and the",
      "autostart unit, and tells you what is missing. Exits 1 when a check fails.",
    ].join("\n"),
    options: ["--json           JSON output"],
    examples: ["pi-farm doctor"],
    see: ["check", "install"],
  },
  {
    name: "init",
    summary: "Write an example config to ~/.pi/farm.yml",
    usage: "pi-farm init [options]",
    details: [
      "Creates a commented example config so `pi-farm up` works out of the box.",
      "Pass `--path <file>` to choose another destination.",
    ].join("\n"),
    options: ["--force          overwrite an existing file", "--path <file>    destination (default ~/.pi/farm.yml)"],
    examples: ["pi-farm init", "pi-farm init --force"],
    see: ["check", "up"],
  },
  {
    name: "install",
    aliases: ["autostart"],
    summary: "Install reboot autostart (systemd / launchd)",
    usage: "pi-farm install [options]",
    details: [
      "Linux: writes ~/.config/systemd/user/pi-farm.service and enables it",
      "(add `--watch N` for a timer that reconciles every N seconds).",
      "macOS: writes ~/Library/LaunchAgents/com.pi-farm.plist.",
      "",
      "The unit runs `up --reconcile`, so sessions stopped by hand are respected.",
      "For boot without login on Linux: sudo loginctl enable-linger $USER",
    ].join("\n"),
    options: [
      "--watch [secs]   also reconcile every N seconds (default 300)",
      "--print          print the unit file and exit; do not install",
      "--dry-run        same as --print",
    ],
    examples: ["pi-farm install", "pi-farm install --watch 300", "pi-farm install --print"],
    see: ["uninstall", "status"],
  },
  {
    name: "uninstall",
    summary: "Remove the autostart unit",
    usage: "pi-farm uninstall [options]",
    details: ["Disables and deletes the systemd unit / launchd plist. Running sessions are left alone."].join("\n"),
    options: ["--dry-run        print what would be removed"],
    examples: ["pi-farm uninstall"],
    see: ["install"],
  },
  {
    name: "version",
    summary: "Print the version",
    usage: "pi-farm version",
    details: ["Same as `pi-farm -V`."].join("\n"),
    options: [],
    examples: ["pi-farm version"],
    see: [],
  },
  {
    name: "help",
    summary: "Show this help, or `pi-farm help <command>`",
    usage: "pi-farm help [command]",
    details: [
      "Without an argument prints the overview. With a command name prints that",
      "command's usage, options and examples. `pi-farm <command> --help` is",
      "equivalent.",
    ].join("\n"),
    options: [],
    examples: ["pi-farm help", "pi-farm help install", "pi-farm up --help"],
    see: [],
  },
];

const byName = new Map();
for (const command of COMMANDS) {
  byName.set(command.name, command);
  for (const alias of command.aliases ?? []) byName.set(alias, command);
}

/** Resolve a command name or alias to its help entry, or null. */
export function findCommand(name) {
  return byName.get(String(name ?? "").toLowerCase()) ?? null;
}

/** Every name and alias, for completions and typo suggestions. */
export function commandNames() {
  return [...byName.keys()];
}

function pad(value, width) {
  return value + " ".repeat(Math.max(0, width - value.length));
}

export function renderOverview(version) {
  const labels = COMMANDS.map((c) =>
    c.aliases?.length ? `${c.name} (${c.aliases.join(", ")})` : c.name,
  );
  const nameWidth = Math.max(...labels.map((l) => l.length));
  const lines = [];
  lines.push(`pi-farm ${version} — keep your pi agents alive in tmux`);
  lines.push("");
  lines.push("Usage:");
  lines.push("  pi-farm <command> [names...] [options]");
  lines.push("  pi-farm help <command>        # detailed help for one command");
  lines.push("");
  lines.push("Commands:");
  COMMANDS.forEach((command, index) => {
    lines.push(`  ${pad(labels[index], nameWidth)}  ${command.summary}`);
  });
  lines.push("");
  lines.push("Global options:");
  lines.push("  -c, --config <path>  Config file (default: ./pi-farm.yml, then ~/.pi/farm.yml)");
  lines.push("      --socket <name>  tmux socket name (overrides tmux.socket in the config)");
  lines.push("      --json           Machine-readable output (up/down/status/check/doctor)");
  lines.push("      --dry-run        Print what would happen; do not touch tmux or files");
  lines.push("      --force          up: recreate already running sessions; init: overwrite");
  lines.push("      --reconcile      up: autostart/watch mode; skip sessions stopped by hand");
  lines.push("  -q, --quiet          Only errors");
  lines.push("  -v, --verbose        Echo tmux commands");
  lines.push("  -h, --help           Show help (per command when one is given)");
  lines.push("  -V, --version        Print the version");
  lines.push("");
  lines.push("restart policies (compose-style):");
  lines.push(RESTART_POLICIES_HELP);
  lines.push("");
  lines.push("Config example:");
  lines.push("  version: 1");
  lines.push("  defaults:");
  lines.push("    agent: pi");
  lines.push("  sessions:");
  lines.push("    - name: backend          # tmux session, pi name and remote-pi name");
  lines.push("      cwd: ~/code/backend");
  lines.push("      restart: unless-stopped");
  lines.push("      pi_session: 1a2b3c4d   # optional: resume this pi session id/path");
  lines.push("    - name: docs");
  lines.push("      cwd: ~/code/docs");
  lines.push("      env:");
  lines.push("        TZ: Asia/Shanghai");
  lines.push("");
  lines.push("Name mapping (all default to the session name):");
  lines.push("  tmux session   tmux_name | name");
  lines.push("  pi --name      pi_session_name | name");
  lines.push("  remote-pi      remote_pi_name | name");
  lines.push("");
  lines.push(`Run 'pi-farm help <command>' for details, e.g. 'pi-farm help install'.`);
  return `${lines.join("\n")}\n`;
}

export function renderCommandHelp(version, name) {
  const command = findCommand(name);
  if (!command) return null;
  const lines = [];
  const alias = command.aliases?.length ? ` (alias: ${command.aliases.join(", ")})` : "";
  lines.push(`pi-farm ${version} — ${command.name}${alias}`);
  lines.push("");
  lines.push("Usage:");
  lines.push(`  ${command.usage}`);
  lines.push("");
  lines.push(command.details);
  if (command.options?.length) {
    lines.push("");
    lines.push("Options:");
    for (const option of command.options) lines.push(`  ${option}`);
    lines.push("  -c, --config <path>   config file");
    lines.push("      --socket <name>   tmux socket name");
    lines.push("  -h, --help            show this help");
  }
  if (command.examples?.length) {
    lines.push("");
    lines.push("Examples:");
    for (const example of command.examples) lines.push(`  ${example}`);
  }
  if (command.see?.length) {
    lines.push("");
    lines.push(`See also: ${command.see.map((c) => `'pi-farm help ${c}'`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Closest command name for a typo, or null. */
export function suggestCommand(input) {
  const target = String(input ?? "").toLowerCase();
  let best = null;
  for (const name of commandNames()) {
    const distance = editDistance(target, name);
    if (distance <= 2 && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name ?? null;
}

function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}
