# 事故处理手册（`pp runbook`）

> 这份文件由 `src/runbook.js` 生成：`pp runbook --markdown > docs/runbook.md`。
> 每一步都是先**只读**地看清楚，再决定要不要动。

场景一览：`nothing-runs` · `no-delivery` · `session-dies` · `machine-unreachable` · `disk-full` · `agent-stuck` · `after-reboot` · `remote-reboot` · `config-broken`

## Every session is gone（`nothing-runs`）

**症状**：pp ls says 0/N running, tmux ls says nothing

The tmux server is not there. Either nothing started it after a reboot, or something stopped the unit that owns it — a unit stop takes its whole cgroup with it.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `tmux ls` | can't find session … — the server itself is gone, not the sessions |
| 2 | `pp doctor --brief` | which of config / tmux / autostart is the one that is off |
| 3 | `pp install` | installed: ~/.config/systemd/user/pi-plus.service, enabled |
| 4 | `pp up --drift` | N started, 0 already running, 0 failed — every session back |
| 5 | `pp audit --action down --limit 5` | if somebody (or something) stopped them on purpose, this says who |

准备好动的时候：`pp up`

## A cron job is not delivering（`no-delivery`）

**症状**：the job says deferred or late, or the session's input box is filled but nothing was sent

Three different things look identical from the outside: the tick is not firing at all, the job is behind a target that is mid-turn (deferred, which is by design), or the Enter never took.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp cron ls` | the next column: in 3m (10:40) is fine, late 40m (10:00) is not |
| 2 | `pp doctor --brief` | ✗ cron <id> is 30m late — pp cron run <id> |
| 3 | `crontab -l | grep 'cron tick'` | exactly one line: * * * * * … pp cron tick --quiet |
| 4 | `pp cron run <id>` | delivered <id> — …, or deferred: <session> is working |
| 5 | `pp logs <session> -n 20` | on deferred: the agent is mid-turn; on failure: the pane shows why |

准备好动的时候：`pp install`

## A session starts and dies immediately（`session-dies`）

**症状**：pp ls shows off, pp up says exited immediately

Almost always the working directory, the agent binary, or an argument: tmux itself is fine, the thing inside it is not. remote-pi sessions on other machines fail the same way for the same three reasons.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp why <name>` | the one line that matters: cwd missing / agent not found / restart policy |
| 2 | `pp check --brief` | 1 problem: "<name>": cwd does not exist: /srv/… |
| 3 | `pp logs <name> -n 30` | the actual error from the agent, not from pp |
| 4 | `pp node exec <machine> -- command -v pi` | on a remote session: an empty answer means the agent is not installed there |

准备好动的时候：`pp up <name> --wait`

## A machine cannot be reached（`machine-unreachable`）

**症状**：pp node test <machine> fails, pp status shows unreachable

pp can only say what ssh says. Distinguish: no route, a key that is not loaded, a password node that needs sshpass, or a host key that changed.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp node show <machine>` | the target, and how it authenticates (key:… / password / env:VAR) |
| 2 | `pp node test <machine>` | reachable in 380ms, or the ssh error verbatim |
| 3 | `ssh -o BatchMode=yes <user>@<host> true` | rc 0 means ssh itself is fine and the problem is elsewhere |
| 4 | `pp why --node <machine>` | what pp would still do with it once it is back |

准备好动的时候：`pp node test --all`

## The disk is filling up（`disk-full`）

**症状**：pp doctor shows ✗ logs, writes start failing

Nothing rotates anything by design: a session's log is a file that keeps growing, because losing output is worse than using disk. pp clean shrinks in place (no rename), so an open pipe-pane keeps writing to the same file.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp doctor --brief` | ✗ logs  cron.log 57.2 MB — shrink: pp clean |
| 2 | `pp clean --dry-run` | would shrink <file> 57.2 MB → 2.0 MB |
| 3 | `pp clean` | shrank <file> … and N MB freed |
| 4 | `df -h .` | after: enough headroom for the next day |

准备好动的时候：`pp clean`

## An agent has been quiet for a long time（`agent-stuck`）

**症状**：pp doctor shows ✗ stalls, the panel shows a yellow idle

Quiet is measured by new output, not by elapsed time: a 40-minute build is working, a frozen tool call is not. pp cannot tell them apart on its own, so it says who to look at.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp doctor --brief` | ✗ stalls <name> no new output for 95m (busy 120m) — look: pp logs <name> |
| 2 | `pp logs <name> -n 40 --stamp` | the last tool call and whether its timestamp is older than the quiet time |
| 3 | `pp why <name>` | agent mid-turn — a prompt sent now is queued, not lost |
| 4 | `tmux send-keys -t =<name>: C-c` | interrupt the turn; the session and its history survive |

准备好动的时候：`pp logs <name> -f`

## The machine rebooted and nothing came back（`after-reboot`）

**症状**：everything was running before the reboot, nothing is now

Autostart has three parts and all three must hold: the unit is installed, it is enabled for this user, and the user's systemd survives logout (linger on WSL/headless).

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp doctor --brief` | ✗ autostart systemd (not installed: ~/.config/systemd/user/pi-plus.service) |
| 2 | `pp install` | installed …, enabled … |
| 3 | `systemctl --user status pi-plus.service` | active (exited) — a oneshot that ran and left the sessions behind |
| 4 | `loginctl show-user $(id -un) -p Linger` | Linger=yes; without it the user manager stops at logout |
| 5 | `pp up --drift` | the sessions that should be up and are not, started |

准备好动的时候：`pp install`

## A machine I manage rebooted and its sessions did not come back（`remote-reboot`）

**症状**：pp status shows every session on one NODE as off, while the other machines are fine

Nothing on that machine starts pp sessions: pp is not installed there, and this machine reaches it over ssh. Only this side can bring them back — by hand, or by the --heal job.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp node test <machine>` | reachable — tmux 3.4 · pi installed (350ms) |
| 2 | `pp why --node <machine>` | 2 of 2 session(s) down, each with its own line |
| 3 | `pp up --drift` | starting 2 missing: … — and then the same sessions are running again |
| 4 | `pp cron add --heal --every 5m` | so the next reboot fixes itself before you notice |

准备好动的时候：`pp up --drift`

## Somebody edited the config and now it is not right（`config-broken`）

**症状**：a command fails with a yaml/session error, sessions went missing from the list, or the file is shorter than you remember

plus.yml is a file people edit by hand. The previous copy of it is on disk — pp keeps one before any change it makes, and pp backup makes one before any change a human makes.

| # | 跑什么 | 应该看到 |
| --- | --- | --- |
| 1 | `pp check` | error: <file>:<line>: … — the first line that does not parse, not the last |
| 2 | `pp backup --list` | 2026-05-01T10-00-12-345  6 file(s)  334.7 KB — the newest is on top of the list |
| 3 | `pp restore latest --dry-run` | the diff it would apply, in the same shape as pp audit --action config.changed |
| 4 | `pp restore latest --force` | restored 1 file(s) — and the broken one is kept as a backup of its own |
| 5 | `pp check` | ok config looks usable, and pp ls lists the sessions you remember |

准备好动的时候：`pp restore latest`

