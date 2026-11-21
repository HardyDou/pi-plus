/**
 * `pp runbook`: the incident table, as data.
 *
 * Every entry is something that has actually happened on this fleet at least
 * once, written down in the order a calm person would work through it: one
 * command, what the healthy answer looks like, and only then the command that
 * changes something. The point is that at 3am nobody has to remember which of
 * six tools to open first — and nobody has to trust their memory for what
 * "normal" looks like.
 *
 * Nothing here is executed by pp; `pp runbook --run` runs the *read-only*
 * steps only, so a tired operator cannot break a machine by pressing enter.
 */

export const RUNBOOK = [
  {
    id: "nothing-runs",
    title: "Every session is gone",
    symptom: "pp ls says 0/N running, tmux ls says nothing",
    means:
      "The tmux server is not there. Either nothing started it after a reboot, or something stopped the unit that owns it — a unit stop takes its whole cgroup with it.",
    steps: [
      { do: "tmux ls", see: "can't find session … — the server itself is gone, not the sessions" },
      { do: "pp doctor --brief", see: "which of config / tmux / autostart is the one that is off" },
      { do: "pp install", see: "installed: ~/.config/systemd/user/pi-plus.service, enabled" },
      { do: "pp up --drift", see: "N started, 0 already running, 0 failed — every session back" },
      { do: "pp audit --action down --limit 5", see: "if somebody (or something) stopped them on purpose, this says who" },
    ],
    fix: "pp up",
  },
  {
    id: "no-delivery",
    title: "A cron job is not delivering",
    symptom: "the job says deferred or late, or the session's input box is filled but nothing was sent",
    means:
      "Three different things look identical from the outside: the tick is not firing at all, the job is behind a target that is mid-turn (deferred, which is by design), or the Enter never took.",
    steps: [
      { do: "pp cron ls", see: "the next column: in 3m (10:40) is fine, late 40m (10:00) is not" },
      { do: "pp doctor --brief", see: "✗ cron <id> is 30m late — pp cron run <id>" },
      { do: "crontab -l | grep 'cron tick'", see: "exactly one line: * * * * * … pp cron tick --quiet" },
      { do: "pp cron run <id>", see: "delivered <id> — …, or deferred: <session> is working" },
      { do: "pp logs <session> -n 20", see: "on deferred: the agent is mid-turn; on failure: the pane shows why" },
    ],
    fix: "pp install",
  },
  {
    id: "session-dies",
    title: "A session starts and dies immediately",
    symptom: "pp ls shows off, pp up says exited immediately",
    means:
      "Almost always the working directory, the agent binary, or an argument: tmux itself is fine, the thing inside it is not. remote-pi sessions on other machines fail the same way for the same three reasons.",
    steps: [
      { do: "pp why <name>", see: "the one line that matters: cwd missing / agent not found / restart policy" },
      { do: "pp check --brief", see: "1 problem: \"<name>\": cwd does not exist: /srv/…" },
      { do: "pp logs <name> -n 30", see: "the actual error from the agent, not from pp" },
      { do: "pp node exec <machine> -- command -v pi", see: "on a remote session: an empty answer means the agent is not installed there" },
    ],
    fix: "pp up <name> --wait",
  },
  {
    id: "machine-unreachable",
    title: "A machine cannot be reached",
    symptom: "pp node test <machine> fails, pp status shows unreachable",
    means:
      "pp can only say what ssh says. Distinguish: no route, a key that is not loaded, a password node that needs sshpass, or a host key that changed.",
    steps: [
      { do: "pp node show <machine>", see: "the target, and how it authenticates (key:… / password / env:VAR)" },
      { do: "pp node test <machine>", see: "reachable in 380ms, or the ssh error verbatim" },
      { do: "ssh -o BatchMode=yes <user>@<host> true", see: "rc 0 means ssh itself is fine and the problem is elsewhere" },
      { do: "pp why --node <machine>", see: "what pp would still do with it once it is back" },
    ],
    fix: "pp node test --all",
  },
  {
    id: "disk-full",
    title: "The disk is filling up",
    symptom: "pp doctor shows ✗ logs, writes start failing",
    means:
      "Nothing rotates anything by design: a session's log is a file that keeps growing, because losing output is worse than using disk. pp clean shrinks in place (no rename), so an open pipe-pane keeps writing to the same file.",
    steps: [
      { do: "pp doctor --brief", see: "✗ logs  cron.log 57.2 MB — shrink: pp clean" },
      { do: "pp clean --dry-run", see: "would shrink <file> 57.2 MB → 2.0 MB" },
      { do: "pp clean", see: "shrank <file> … and N MB freed" },
      { do: "df -h .", see: "after: enough headroom for the next day" },
    ],
    fix: "pp clean",
  },
  {
    id: "agent-stuck",
    title: "An agent has been quiet for a long time",
    symptom: "pp doctor shows ✗ stalls, the panel shows a yellow idle",
    means:
      "Quiet is measured by new output, not by elapsed time: a 40-minute build is working, a frozen tool call is not. pp cannot tell them apart on its own, so it says who to look at.",
    steps: [
      { do: "pp doctor --brief", see: "✗ stalls <name> no new output for 95m (busy 120m) — look: pp logs <name>" },
      { do: "pp logs <name> -n 40 --stamp", see: "the last tool call and whether its timestamp is older than the quiet time" },
      { do: "pp why <name>", see: "agent mid-turn — a prompt sent now is queued, not lost" },
      { do: "tmux send-keys -t =<name>: C-c", see: "interrupt the turn; the session and its history survive" },
    ],
    fix: "pp logs <name> -f",
  },
  {
    id: "after-reboot",
    title: "The machine rebooted and nothing came back",
    symptom: "everything was running before the reboot, nothing is now",
    means:
      "Autostart has three parts and all three must hold: the unit is installed, it is enabled for this user, and the user's systemd survives logout (linger on WSL/headless).",
    steps: [
      { do: "pp doctor --brief", see: "✗ autostart systemd (not installed: ~/.config/systemd/user/pi-plus.service)" },
      { do: "pp install", see: "installed …, enabled …" },
      { do: "systemctl --user status pi-plus.service", see: "active (exited) — a oneshot that ran and left the sessions behind" },
      { do: "loginctl show-user $(id -un) -p Linger", see: "Linger=yes; without it the user manager stops at logout" },
      { do: "pp up --drift", see: "the sessions that should be up and are not, started" },
    ],
    fix: "pp install",
  },
  {
    id: "config-broken",
    title: "Somebody edited the config and now it is not right",
    symptom: "a command fails with a yaml/session error, sessions went missing from the list, or the file is shorter than you remember",
    means:
      "plus.yml is a file people edit by hand. The previous copy of it is on disk — pp keeps one before any change it makes, and pp backup makes one before any change a human makes.",
    steps: [
      { do: "pp check", see: "error: <file>:<line>: … — the first line that does not parse, not the last" },
      { do: "pp backup --list", see: "2026-05-01T10-00-12-345  6 file(s)  334.7 KB — the newest is on top of the list" },
      { do: "pp restore latest --dry-run", see: "the diff it would apply, in the same shape as pp audit --action config.changed" },
      { do: "pp restore latest --force", see: "restored 1 file(s) — and the broken one is kept as a backup of its own" },
      { do: "pp check", see: "ok config looks usable, and pp ls lists the sessions you remember" },
    ],
    fix: "pp restore latest",
  },
];

export function findScenario(id) {
  const wanted = String(id ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return RUNBOOK.find((entry) => entry.id === wanted) ?? RUNBOOK.find((entry) => entry.title.toLowerCase().includes(wanted)) ?? null;
}

/** One scenario as text: what it means, then one command per line with what to expect. */
export function renderScenario(scenario, { width = 0 } = {}) {
  const lines = [`${scenario.title}`, `  ${scenario.symptom}`, "", scenario.means, ""];
  scenario.steps.forEach((step, index) => {
    lines.push(`${String(index + 1).padStart(2, " ")}  ${step.do}`);
    lines.push(`    expect: ${step.see}`);
  });
  lines.push("");
  lines.push(`when you are ready to change something: ${scenario.fix}`);
  return lines.join("\n");
}

/** The whole table as markdown, so `docs/runbook.md` can never drift from the code. */
export function renderMarkdown() {
  const out = [
    "# 事故处理手册（`pp runbook`）",
    "",
    "> 这份文件由 `src/runbook.js` 生成：`pp runbook --markdown > docs/runbook.md`。",
    "> 每一步都是先**只读**地看清楚，再决定要不要动。",
    "",
    `场景一览：${RUNBOOK.map((entry) => `\`${entry.id}\``).join(" · ")}`,
    "",
  ];
  for (const scenario of RUNBOOK) {
    out.push(`## ${scenario.title}（\`${scenario.id}\`）`, "");
    out.push(`**症状**：${scenario.symptom}`, "");
    out.push(`${scenario.means}`, "");
    out.push("| # | 跑什么 | 应该看到 |", "| --- | --- | --- |");
    scenario.steps.forEach((step, index) => {
      out.push(`| ${index + 1} | \`${step.do}\` | ${step.see} |`);
    });
    out.push("", `准备好动的时候：\`${scenario.fix}\``, "");
  }
  return out.join("\n");
}
