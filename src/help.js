// Single source of truth for `pp help` — the overview, per-command pages and
// the shell completion word list are all generated from COMMANDS.

export const RESTART_POLICIES_HELP = [
  "  no               never started by a bare `up`, autostart or `--watch`",
  "  always           started, and brought back when it dies (default)",
  "  on-failure       like always, but a manual `down` is remembered",
  "  unless-stopped   like always, but a manual `down` is remembered",
].join("\n");

export const COMMANDS = [
  {
    name: "new",
    aliases: ["n", "create"],
    summary: "Start a one-off session in a directory, no config needed",
    usage: "pp new [name] [options]",
    details: [
      "Creates a detached session for the current directory (or --dir/-C <path>)",
      "without touching any config file. The name defaults to the directory name,",
      "sanitised to tmux-safe characters and suffixed -2/-3 if it is already taken.",
      "",
      "The agent defaults to `pi`; it gets `--name <session>` and a remote-pi name",
      "equal to the session name, injected through the environment so the project's",
      ".pi/remote-pi/config.json is never rewritten.",
      "",
      "Add --save to append the session to the config file (created if missing) so",
      "it survives a reboot, and --attach/-a to jump straight into it.",
    ].join("\n"),
    options: [
      "-C, --dir <path>  directory to run in (default: current directory)",
      "--agent <cmd>     agent command (default: pi)",
      "--log             keep full output in ~/.pi/plus/logs/<name>.log",
      "--save            append the session to the config file",
      "-a, --attach      attach after starting",
      "--no-remote-pi    do not set a remote-pi name",
      "--force           recreate the tmux session if the name is taken",
      "--dry-run         print the tmux command instead of running it",
    ],
    examples: [
      "pp new",
      "pp new api -C ~/code/api --attach",
      "pp new scratch --agent bash --log --save",
    ],
    see: ["up", "attach", "init"],
  },
  {
    name: "up",
    aliases: ["start"],
    summary: "Create/start configured sessions, detached (default: all)",
    usage: "pp up [name|#...] [options]",
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
    examples: ["pp up", "pp up backend", "pp up backend --force", "pp up --dry-run -v"],
    see: ["status", "restart", "attach"],
  },
  {
    name: "down",
    aliases: ["stop"],
    summary: "Stop sessions",
    usage: "pp down [name|#...] [options]",
    details: [
      "Stops tmux sessions (and everything running inside them).",
      "With no names every configured session is stopped, whatever its policy.",
      "",
      "For `unless-stopped` and `on-failure` a manual stop is remembered, so",
      "autostart and `--watch` will not bring the session back. `up <name>`",
      "clears that record again.",
    ].join("\n"),
    options: ["--dry-run        print what would be stopped", "--json           JSON output"],
    examples: ["pp down backend", "pp down", "pp down backend docs"],
    see: ["up", "restart", "status"],
  },
  {
    name: "restart",
    summary: "Restart sessions (kill + up)",
    usage: "pp restart [name|#...] [options]",
    details: [
      "Equivalent to `down <names>` followed by `up <names>`, including the",
      "`--force` behaviour. Sessions with `restart: no` are skipped when no name",
      "is given, and are restarted when named explicitly.",
    ].join("\n"),
    options: ["--dry-run        print the tmux commands instead of running them", "--json           JSON output"],
    examples: ["pp restart backend", "pp restart"],
    see: ["up", "down"],
  },
  {
    name: "status",
    aliases: ["ls", "list"],
    summary: "Show config, tmux state, pi session and remote-pi name",
    usage: "pp status [name|#...] [options]",
    details: [
      "Prints one row per configured session: #, tmux name, state, restart policy,",
      "pid, agent, cwd, pi session and remote-pi name.",
      "",
      "The # column is the session's position in the config (1-based). Every",
      "command that takes a session accepts that number instead of the name,",
      "e.g. `pp attach 3`. An exact name match always wins over a number.",
      "",
      "States: running, attached, dead (pane alive but the agent exited),",
      "stopped, off (never auto-started or stopped by hand).",
    ].join("\n"),
    options: ["--json           machine-readable JSON", "-q, --quiet      only the table, no summary line"],
    examples: ["pp status", "pp status backend", "pp status 3", "pp ls"],
    see: ["logs", "doctor"],
  },
  {
    name: "attach",
    aliases: ["a"],
    summary: "Attach to a session (starts it if missing)",
    usage: "pp attach <name|#> [options]",
    details: [
      "Attaches the current terminal to the tmux session. If the session does not",
      "exist it is started first. Detach with `Ctrl-b d` — the agent keeps running.",
    ].join("\n"),
    options: ["--dry-run        print the tmux command instead of attaching"],
    examples: ["pp attach backend", "pp attach 3", "pp a 3"],
    see: ["up", "status"],
  },
  {
    name: "logs",
    aliases: ["log"],
    summary: "Print recent pane output (--lines N, default 200)",
    usage: "pp logs <name|#> [options]",
    details: [
      "Dumps the tail of the tmux pane, so you can see what the agent printed",
      "without attaching. Use `log:` in the config to keep the full output in a",
      "file via `pipe-pane`.",
    ].join("\n"),
    options: ["-n, --lines <n>  how many scrollback lines (default 200)"],
    examples: ["pp logs backend", "pp logs 3 -n 1000"],
    see: ["send", "status"],
  },
  {
    name: "send",
    summary: 'Type text into the pane and press Enter (--no-enter)',
    usage: 'pp send <name|#> "text" [options]',
    details: [
      "Sends keystrokes to the session's pane and presses Enter, which is handy",
      "for pushing a prompt into a running agent from another shell or a script.",
    ].join("\n"),
    options: ["--no-enter       do not press Enter after the text"],
    examples: ['pp send backend "run the tests"', 'pp send 3 "yes" --no-enter'],
    see: ["logs", "attach"],
  },
  {
    name: "push",
    aliases: ["put", "upload"],
    summary: "Copy a file to another machine and type its path into a tmux pane",
    usage: "pp push <file> [options]",
    details: [
      "Sends one file over ssh and prefills its remote path into a tmux session,",
      "so a screenshot or a log lands exactly where you would have typed it.",
      "",
      "Where it goes, in order: --push <target>, $PP_PUSH_TARGET, the `push:` block",
      "in the config, the ssh client found in this shell's process table, and",
      "finally the local hostname. A target is [user@]host[:port][#session] —",
      "`pp push a.png --push hardy@1.2.3.4:2222#delta` is allowed.",
      "",
      "Authentication is left entirely to ssh: the command opens (or reuses) a",
      "ControlMaster connection under ~/.ssh/cm-pp-*, so a password typed once",
      "keeps working for --persist seconds (default 600) without touching",
      "~/.ssh/config. Keys and the agent work as usual.",
      "",
      "Files land in ~/.pi/plus/drops/<session>/ by default (override with",
      "--remote-dir or `push.dir`). The path is typed into the pane with",
      "`tmux send-keys -l` and no Enter is pressed — you decide when to send it.",
    ].join("\n"),
    options: [
      "--push <target>     [user@]host[:port][#session]",
      "--to <session>      tmux session on the remote side (default: the attached one)",
      "--remote-dir <dir>  remote directory (default ~/.pi/plus/drops/<session>)",
      "--no-prefill        copy the file but type nothing",
      "--persist <secs>    how long the ssh master connection stays alive (default 600)",
      "--control-path <p>  ControlMaster socket (~/.ssh/cm-pp-%r@%h-%p)",
      "--no-detect         never guess the target from the process table",
      "--socket <name>     tmux socket on the remote side",
      "--dry-run           print every ssh/scp command instead of running it",
      "--json              machine-readable result",
    ],
    examples: [
      "pp push ./crash.log --push hardy@1.2.3.4:delta",
      "pp push ./screen.png --push delta",
      "PP_PUSH_TARGET=mybox:delta pp push ./a.png",
      "pp push ./a.png --push mybox --to risk-01 --no-prefill",
      "pp push ./a.png --push mybox:delta --dry-run",
    ],
    see: ["shot", "send", "status"],
  },
  {
    name: "shot",
    aliases: ["snap"],
    summary: "Screenshot on macOS and push it into a remote pi session",
    usage: "pp shot [options]",
    details: [
      "Takes a screenshot (screencapture -i: pick an area) and runs `pp push` on",
      "it, so the remote pane receives the path of the image — no clipboard, no",
      "paste, no upload. `--clipboard` uses the image already on the pasteboard",
      "instead of taking a new shot; `--full` captures the whole screen.",
      "",
      "This is the macOS side of the workflow: pi runs on the machine you ssh",
      "into, you take screenshots on the machine you sit at. Because the path is",
      "typed rather than pasted, it survives any terminal, multiplexer or latency.",
      "",
      "Needs macOS for the capture step (pp push works everywhere); the target",
      "resolution, ssh connection reuse and prefill behave exactly like `pp push`.",
    ].join("\n"),
    options: [
      "--clipboard         use the image already on the clipboard",
      "--full              capture the whole screen (no area selection)",
      "--out-dir <dir>     where the local copy is written (~/.pi/plus/cache)",
      "plus every option of `pp push` (--push/--to/--no-prefill/--dry-run/--json)",
    ],
    examples: [
      "pp shot --push hardy@1.2.3.4:delta",
      "pp shot --clipboard --push mybox",
      "PP_PUSH_TARGET=mybox:delta pp shot",
    ],
    see: ["push", "attach"],
  },
  {
    name: "mesh",
    aliases: [],
    summary: "Talk to the remote-pi agent mesh (ls / send / resolve / inbox)",
    usage: "pp mesh <ls|send|resolve|inbox> ...",
    details: [
      "pp talks to remote-pi's local broker directly over its UNIX socket",
      "(~/.pi/remote/sessions/local/broker.sock) — no dependencies, no pi needed.",
      "",
      "  ls        list every peer in the mesh (read-only probe: it never registers,",
      "            so nobody sees a peer_joined/peer_left because of it)",
      "  resolve   map a configured session to its mesh address and online state",
      "  send      register as an ephemeral peer (default name pp-mesh), deliver the",
      "            text, and wait for the broker ACK",
      "  inbox     register and stay online, printing every message that arrives",
      "            (default name pp-inbox; Ctrl-C to leave)",
      "",
      "Targets may be a session name or #index (resolved through the config), a raw",
      "mesh address (<cwd>@<name>, or macbook:/path@name for cross-PC), `all`, or",
      "`broadcast`. One target = unicast with ACK (received/busy/denied/timeout);",
      "several targets or `all` = multicast, fire-and-forget.",
      "",
      "A busy peer drops the message (broker ACK `busy`) — retry later or --no-wait.",
      "Cross-PC delivery rides the broker leader's relay bridge, so no pairing.",
    ].join("\n"),
    options: [
      "--json             JSON output (ls/resolve; one JSON object per line for inbox)",
      "--as <name>        mesh name to register as (default: pp-mesh / pp-inbox)",
      "--wait <ms>        ACK timeout, default 5000",
      "--no-wait          fire-and-forget: do not wait for the ACK",
      "--reply <ms>       keep listening after the ACK and print the reply envelope(s)",
      "--body-json <json> send structured JSON instead of plain text",
      "--dry-run          print the envelope instead of sending it",
    ],
    examples: [
      "pp mesh ls",
      "pp mesh resolve backend",
      'pp mesh send backend "the build is green"',
      'pp mesh send 1 3 "heads up: rebooting the box"',
      'pp mesh send all "standup in 5"',
      "pp mesh send macbook:/Users/me/code/api@api \"ping\" --wait 2000",
      "pp mesh inbox --as pp-worker",
      "pp mesh inbox --json --as pp-worker | tee mesh.jsonl",
    ],
    see: ["send", "status"],
  },
  {
    name: "check",
    aliases: ["validate"],
    summary: "Validate the config without touching tmux",
    usage: "pp check [options]",
    details: [
      "Parses the config, expands paths and prints a per-session summary of what",
      "would be started, plus warnings (shared cwd, disabled sessions, ...).",
      "Safe to run in CI.",
    ].join("\n"),
    options: ["--json           JSON output"],
    examples: ["pp check", "pp check -c ./pi-plus.yml --json"],
    see: ["doctor", "init"],
  },
  {
    name: "doctor",
    summary: "Environment + config diagnostics",
    usage: "pp doctor [options]",
    details: [
      "Checks node, tmux, pi, the config file, the remote-pi plugin and the",
      "autostart unit, and tells you what is missing. Exits 1 when a check fails.",
    ].join("\n"),
    options: ["--json           JSON output"],
    examples: ["pp doctor"],
    see: ["check", "install"],
  },
  {
    name: "init",
    summary: "Write an example config to ~/.pi/plus.yml",
    usage: "pp init [options]",
    details: [
      "Creates a commented example config so `pp up` works out of the box.",
      "Pass `--path <file>` to choose another destination.",
    ].join("\n"),
    options: ["--force          overwrite an existing file", "--path <file>    destination (default ~/.pi/plus.yml)"],
    examples: ["pp init", "pp init --force"],
    see: ["check", "up"],
  },
  {
    name: "install",
    aliases: ["autostart"],
    summary: "Install reboot autostart (systemd / launchd)",
    usage: "pp install [options]",
    details: [
      "Linux: writes ~/.config/systemd/user/pi-plus.service and enables it",
      "(add `--watch N` for a timer that reconciles every N seconds).",
      "macOS: writes ~/Library/LaunchAgents/com.pi-plus.plist.",
      "",
      "The unit runs `up --reconcile`, so sessions stopped by hand are respected.",
      "For boot without login on Linux: sudo loginctl enable-linger $USER",
    ].join("\n"),
    options: [
      "--watch [secs]   also reconcile every N seconds (default 300)",
      "--print          print the unit file and exit; do not install",
      "--dry-run        same as --print",
    ],
    examples: ["pp install", "pp install --watch 300", "pp install --print"],
    see: ["uninstall", "status"],
  },
  {
    name: "uninstall",
    summary: "Remove the autostart unit",
    usage: "pp uninstall [options]",
    details: ["Disables and deletes the systemd unit / launchd plist. Running sessions are left alone."].join("\n"),
    options: ["--dry-run        print what would be removed"],
    examples: ["pp uninstall"],
    see: ["install"],
  },
  {
    name: "update",
    aliases: ["upgrade"],
    summary: "Upgrade this install to the newest published version",
    usage: "pp update [--check] [--dry-run] [--registry <url>]",
    details: [
      "Asks the registry for the newest version and upgrades whichever way this copy was installed: an npm global install runs `npm i -g pi-farm@<latest>`, a git checkout (install.sh) runs `git pull --ff-only`.",
      "Nothing runs when you are already current. `--check` only reports and exits 1 when an update exists, which makes it usable from a script or a cron job.",
      "The version check needs network access; set PP_NPM_REGISTRY or --registry when the default https://registry.npmjs.org is not reachable.",
      "Upgrading does not touch your config, your sessions or the autostart unit — the unit points at the installed script, so it picks up the new version on the next run.",
    ].join("\n"),
    options: [
      "--check          report only; exit 1 when an update is available",
      "--dry-run        print the upgrade command without running it",
      "--registry <url> registry to ask (default https://registry.npmjs.org)",
      "--json           machine-readable output",
    ],
    examples: [
      "pp update",
      "pp update --check",
      "pp update --dry-run",
      "PP_NPM_REGISTRY=https://nexus.local/repository/npm-group pp update",
    ],
    see: ["version", "doctor"],
  },
  {
    name: "alias",
    aliases: ["link"],
    summary: "Add another command name when `pp` is taken by another program",
    usage: "pp alias [ls | add <name> | rm <name>] [--bin-dir <dir>]",
    details: [
      "macOS ships /usr/bin/pp (an ASN.1 pretty printer) and a few Linux distros do too, so typing `pp ls` can reach a binary that knows nothing about sessions. npm already installs two extra names for this reason: `pifarm` and `pi-plus`.",
      "`pp alias add <name>` puts a symlink to this CLI into a bin directory that is on PATH, so any short name you like works: pp alias add pif → pif ls.",
      "Default directory: ~/.local/bin, or $PP_BIN_DIR; `--bin-dir` overrides it for one call. The symlink points at this script, so upgrading through npm keeps the alias valid.",
      "`pp alias rm <name>` removes only symlinks that point at this CLI; anything else is left alone (delete it yourself).",
      "pp doctor reports which names resolve to us and which belong to another program.",
    ].join("\n"),
    options: [
      "--bin-dir <dir>  directory to link into (default ~/.local/bin)",
      "--force          replace an existing non-symlink file",
      "--json           machine-readable output",
    ],
    examples: [
      "pp alias ls",
      "pp alias add pif",
      "pp alias add p --bin-dir /usr/local/bin",
      "pp alias rm pif",
    ],
    see: ["doctor", "install"],
  },
  {
    name: "version",
    summary: "Print the version",
    usage: "pp version",
    details: ["Same as `pp -V`."].join("\n"),
    options: [],
    examples: ["pp version"],
    see: [],
  },
  {
    name: "help",
    summary: "Show this help, or `pp help <command>`",
    usage: "pp help [command]",
    details: [
      "Without an argument prints the overview. With a command name prints that",
      "command's usage, options and examples. `pp <command> --help` is",
      "equivalent.",
    ].join("\n"),
    options: [],
    examples: ["pp help", "pp help install", "pp up --help"],
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
  lines.push(`pp ${version} — keep your pi agents alive in tmux`);
  lines.push("");
  lines.push("Usage:");
  lines.push("  pp <command> [names...] [options]");
  lines.push("  pp help <command>        # detailed help for one command");
  lines.push("");
  lines.push("Commands:");
  COMMANDS.forEach((command, index) => {
    lines.push(`  ${pad(labels[index], nameWidth)}  ${command.summary}`);
  });
  lines.push("");
  lines.push("Global options:");
  lines.push("  -c, --config <path>  Config file (default: ./pi-plus.yml, then ~/.pi/plus.yml)");
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
  lines.push("Inside a pi session (extension, `pi install npm:pi-farm`):");
  lines.push("  /pp-ls  /pp-sw <session>  /pp-quit  /pp-status  /pp-peek [session] [-n N]");
  lines.push("");
  lines.push(`Run 'pp help <command>' for details, e.g. 'pp help install'.`);
  return `${lines.join("\n")}\n`;
}

export function renderCommandHelp(version, name) {
  const command = findCommand(name);
  if (!command) return null;
  const lines = [];
  const alias = command.aliases?.length ? ` (alias: ${command.aliases.join(", ")})` : "";
  lines.push(`pp ${version} — ${command.name}${alias}`);
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
    lines.push(`See also: ${command.see.map((c) => `'pp help ${c}'`).join(", ")}`);
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
