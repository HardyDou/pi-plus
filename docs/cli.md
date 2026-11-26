# 命令行参考

`pp` 是唯一入口（包名 `pi-farm`，可执行文件只有 `pp`）。不带参数打印总览与命令列表，想直接看状态用 `pp ls`。

```
pp <command> [names...] [options]
```

## 全局选项

| 选项 | 说明 |
|---|---|
| `-c, --config <path>` | 指定配置文件（覆盖自动发现） |
| `--socket <name>` | 用 `tmux -L <name>` 的独立 socket，等价于配置里的 `tmux.socket` |
| `--json` | 机器可读输出（同时抑制人读文本） |
| `--dry-run` | 只打印会执行的 tmux 命令，不动真实状态 |
| `--force` | 已在运行时也强制重建（`up`）/强制覆盖（`init`） |
| `--reconcile` | 自启/巡检模式：跳过被手动 `down` 过的 `unless-stopped`/`on-failure` |
| `-q, --quiet` | 静默（只输出错误） |
| `-v, --verbose` | 打印每条 tmux 命令 |
| `-n, --lines <N>` | `logs` 显示行数，默认 200 |
| `--no-enter` | `send` 只打字不回车 |
| `-C, --dir <path>` | `new` 的目标目录（默认当前目录） |
| `--agent <cmd>` | `new` 的启动命令（默认 `pi`） |
| `--log` | `new` 时把输出写到 `~/.pi/plus/logs/<name>.log` |
| `--save` | `new` 时把会话追加进配置文件 |
| `-a, --attach` | `new` 建完直接进入 |
| `--no-remote-pi` | `new` 时不给 remote-pi 名字 |
| `--as <name>` | `mesh send` 注册用的名字，默认 `pp-mesh` |
| `--wait <ms>` | `mesh send` 等 ACK 的超时，默认 5000 |
| `--reply <ms>` | `mesh send` 收到 ACK 后继续监听回复的时长（单播收到第一条即返回） |
| `--no-wait` | `mesh send` 只发不等 ACK |
| `--body-json <json>` | `mesh send` 发结构化 JSON（默认发纯文本） |
| `--at <ISO>` | `cron add` 一次性绝对时间（本地时区，如 `2026-11-21T09:00`） |
| `--in <时长>` | `cron add` 一次性相对时间（`30s`/`10m`/`2h`/`1d`） |
| `--every <时长>` | `cron add` 固定间隔重复 |
| `--cron "<表达式>"` | `cron add` crontab 表达式（`"0 9 * * 1-5"`） |
| `--session <name>` | `cron add` 目标会话（默认：当前 tmux 会话） |
| `--all` | `cron add` 投给所有**在跑**的会话（忙的跳过，下一次 tick 补投） |
| `--command <cmd>` | `cron add` 跑 shell 命令而不是往会话里打字 |
| `--catch-up <时长>` | `cron add` 迟到多久之内还要补跑，默认 `2h`，`0` = 不补 |
| `--start` | `cron add` 到点时会话没跑就先 `up` 再投 |
| `--via <backend>` | `cron install` 的调度后端，目前只有 `crond` |
| `--now <ISO>` | `cron tick` 假装现在是这个时间（测试/补跑） |
| `--bin-dir <dir>` | `alias` 的软链目录，默认 `~/.local/bin` 或 `$PP_BIN_DIR` |
| `--check` | `update` 只报告：有新版时退出码 1 |
| `--registry <url>` | `update` 查询/安装用的 npm 源，默认 `https://registry.npmjs.org`（也可用 `$PP_NPM_REGISTRY`） |
| `--print` | `install` 只打印单元文件 |
| `--watch [secs]` | `install` 额外装一个定时器，每 N 秒（默认 300）巡检一次 |
| `-h, --help` | 帮助（`pp help`、`pp <cmd> --help` 等价） |
| `-V, --version` | 打印版本 |

## 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 运行时失败：某个会话起不来、`check` 发现问题、`doctor` 有失败项 |
| `2` | 用法/配置错误：未知命令、未知选项、找不到配置文件、名字不存在、参数非法 |

`--json` 模式下错误仍然是 stderr 纯文本，JSON 只出现在 stdout。

## 命令

### `pp up [name|#...]`

后台创建/启动（别名 `start`）。不带名字 = 所有 `restart != no` 的会话。

- 已在运行 → 跳过（`--force` 则重建）
- pane 已 dead → 按策略重建（`restart: no` 且没点名 → 跳过并提示）
- 统计：`N started, M already running[, K failed]`

```bash
pp up
pp up backend
pp up 2 5 --force
pp up --reconcile          # 自启/巡检用
pp up --dry-run -v
```

JSON：`{ "started": 2, "skipped": 1, "failures": [] }`

### `pp down [name|#...]`

停止（别名 `stop`）。不带名字 = 全部停掉（包括 `restart: no` 的）。

会为 `unless-stopped` / `on-failure` 记录「手动停止」，以免下次巡检把它拉回来。

JSON：`{ "killed": [...], "missing": [...] }`

### `pp rm <name|#>...`

```bash
pp rm scratch            # asks first
pp rm 3                  # by index
pp rm backend docs -y    # no question
pp rm scratch --no-config  # kill the session, keep the entry
```

The destructive counterpart of `down`: it kills the tmux session *and* cuts the
entry out of the config file. `down` leaves the entry in place, so `up` can
bring the session back; `rm` means it is gone.

| option | meaning |
|---|---|
| `--force` | do not ask for confirmation |
| `--no-config` | kill the session, leave the config alone |
| `--dry-run` | print what would be removed |
| `--json` | `{killed, removed, sessions}` |

Without a terminal (a script, an autostart job) it refuses unless `--force` is
given. Comments elsewhere in the file survive — only the deleted block is
rewritten, so the diff stays small.

### `pp sync`：拉，而不是推

机器之间不互相认识，多数机器上根本没有 pp —— 只有你这台有 ssh 配置和凭据。所以是**一处拉、一处存**：

```bash
pp sync                  # 每台一次 ssh（并行），写进本地缓存
pp sync --node work-01    # 只拉那一台
pp sync --json            # 给脚本
```

写进 `$XDG_STATE_HOME/pi-plus/node-live.json`，`pp ls` / `pp tui` 直接读它 —— 所以它们是瞬间的，
并且永远不会卡在一台睡着的机器上。拉不到的机器保留上次的答案，表里写明它有多旧：

```
9/9 running  0/1 asked, 1 from cache  config: ~/.pi/plus.yml
cached: nas 6m — pp sync refreshes it (pp ls --live asks now)
```

`pp install --watch 300` 生成的 systemd 单元里，同一个 oneshot 会跑两条：

```
ExecStart=… pp.js up   --config … --reconcile --quiet
ExecStart=… pp.js sync --config … --quiet
```

所以缓存最多 5 分钟旧；要更近就 `pp sync --quiet` 塞进自己的 cron，或者干脆 `pp ls --live`。

### `pp ls` 看到的是哪台机器

默认是**这一台**。

```bash
pp ls                       # 本机（不问任何节点）
pp ls --node work-01        # 那台机器，包括没人写进配置的会话
pp ls --all                 # nodes: 里所有机器
pp ls --live                # 连"没有任何会话写在配置里"的机器也问
```

为什么不默认问所有机器：六台节点串行 ssh 是秒级 —— 一张要等的表，人不会问第二次。
尾行会写清楚跳过了几台：

```
9/9 running  1/2 nodes asked  config: ~/.pi/plus.yml
2 machine(s) not asked: blog, nas — pp ls --live   (pp fleet always asks)
```

`pp tui` 同理：默认只看本机，按 `n` 在那台机器之间循环（`machine: work-01 (n cycles)`），
远端结果缓存在 `$XDG_STATE_HOME/pi-plus/node-live.json`，`PP_NODE_TTL`（默认 15 秒）内不重复问。

### `pp status` 的尾行

```
2/3 running  2 down (1 cwd is gone, 1 stopped by hand)  1 unmanaged (stray-x) — pp adopt
```

`down` = 配置里有、现在没在跑（`pp up` 能修）；`unmanaged` = 在跑、但配置里没有（`pp adopt` 能收）。
两数都为 0 时这行只显示 `N/N running`。`pp doctor` 里同一条信息叫 `drift`。

括号里是**为什么**，按"多该动手"排序（最多显示三类，剩下的写 `N more`）：

| 说法 | 意思 | 下一步 |
| --- | --- | --- |
| `cwd is gone` | 本地工作目录不存在 | `pp doctor --brief`，改 `cwd` 或建目录 |
| `machine unreachable` | 那台机器 ssh 不上 | `pp node test <name>` |
| `agent exited` | pane 还在、agent 退出了 | `pp logs <name>` |
| `on a drained machine` | 维护窗口里被有意按住 | `pp node undrain <name>` |
| `stopped by hand` | 有人手工停的 | `pp up <name>` |
| `not started` | 该在但没人起过 | `pp up` 或 `pp up --drift` |

`--json` 里同一份信息是 `drift.reasons: [{ why, count }]`，顺序同上；远程会话的 `cwd` 不在这里判断
（只在那台机器上存在），归到 `not started`，要看真因用 `pp doctor --brief --remote`。

### `pp doctor --nodes` 的 `CONFIG` 列

`3/4` = 你为这台机器列了 4 个会话、3 个在跑；`+1` = 它上面还有一个没写进配置的会话。
两个符号分别对应 `pp up` 和 `pp adopt`。

### `pp status <name>`：它为什么在这里

```bash
$ pp status api
#  NAME  STATE    IDLE  RESTART  PID     AGENT  CWD       PI SESSION
1  api   running  12s   always   3798448 pi     /srv/api  api

restarted 3× in 20m — heal ×3 — pp logs api
```

`last start` 说明**这一次**是谁拉起来的；`restarted` 说明它**是不是一直在被拉起来**——前者在
一次快照里就有，后者只有历史能回答。三条一小时的重启，配合 `--heal` 的停手条件（3 次/小时）
基本就是"自愈在反复拉扯"，而"从没起来过"和"起来又死"的处理方式完全不同。

每个会话保留最近 5 条（`RESTART_KEEP`），来源标在 `why`：`up` / `autostart` / `restart` /
`heal` / `panel`。`--json` 里是 `restarts: [{ at, why, by }]`。

### `pp status --watch`：变化的记录，而不是重画的表格

```bash
$ pp status --watch 5
watching ~/.pi/plus.yml — every 5s, ctrl-c to stop  10:31:04

#  NAME   NODE  STATE    IDLE  ...
1  api    -     running  12s   ...
2  web    t114  off (hand) —   ...

10:31:09  api went off
10:31:14  web came back
```

只重画的表只有人盯着才有用；**变化**才是要处理的东西。所以 `--watch` 记住上一拍的样子，
在表下打出跃迁：`went off` / `came back` / `stuck — quiet 95m` / `moving again` /
`node t114 unreachable`，保留最近六条，没有变化时显示 `no changes yet`。

两个刻意的边界：只看**本机** pane 的静默（远端每个会话一次 ssh 太贵），远端只报 `unreachable`；
退出用 `ctrl-c`（SIGINT/SIGTERM 都会让当前画面收尾再退出）。

### `pp doctor --quarantine`

把解析不了的 pp 状态文件移到一边（`state.json.broken-2026-11-21T13-44-09-397Z` 这样的名字），**不是删除**：
坏文件可能仍是"谁手工停了什么"的唯一记录。移动后 pp 会写新的，`pp doctor` 也就不再报。

```bash
$ pp doctor
✗ own files      cron.json 1 of 2 job(s) have no id or schedule (they will never run) — pp doctor --quarantine moves it aside
$ pp doctor --quarantine
moved cron.json → /home/u/.local/state/pi-plus/cron.json.broken-2026-11-21T13-44-09-397Z
1 file(s) kept as .broken-*; pp will write fresh ones
```

### `pp doctor --brief`：先做哪一件

```bash
$ pp doctor --brief
first: pp install — autostart: systemd, not enabled — pp install
then:  pp up --drift — drift: off: parked, other — pp up
2 of 18 checks need attention — pp doctor
```

3am 的时候，"哪里不对"不如"**现在敲哪一条**"。所以每个检查都带着能修好它的命令，
`--brief` 按"解开多少东西"排序后只报前两条：配置 → disk → node/tmux/pi → 命令名/扩展 →
自启 → cron → drift → pipes → logs → stalls（最后这个要人去看，不是一条命令）。

`--json` 里每个 check 都带 `fix`，并多一个 `failed: ["drift","logs"]`，方便别的系统直接消费。
一切正常时只输出 `ok 18 checks, nothing to do`（退出码 0）；有问题退出码 1。

### `pp status` 的 `CRON` 列

"有几个定时任务正对着这个会话"，`*` 表示有任务会往**每个**在跑的会话投递（例如
`pp cron add --all --every 10m "…"`）。会话行为诡异时（输入框里突然多出一段话、自己在跑），
先看这一列，再看 `pp cron ls`。只在真有任务时出现，平时不占宽度。

### `pp status` 的 `TODOS` 列

会话里还压着未处理的事（`pp todo` 记的未回答提问、未读的一轮）时，表格多一列 `TODOS`：

```bash
pp status
#  #  NAME              STATE    IDLE  RESTART  PID     ...  TODOS
#  1  mango-release-01  running  0s    always   12345   ...      2
```

黄色数字 = 有 N 件事在等；`-` 表示干净。`--json` 里是 `todos`。面板（`pp tui`）的会话行末尾同样带 `2?`。

### `pp status` 的 `CLIENT` 列

有客户端连着会话时，表格末尾会多一列 `CLIENT`，形如 `user@/dev/pts/23`。杀会话之前先看这一列 ——
"别人正看着这个会话"和"没人管"是两件不同的事。

### `pp status`：`off` 和 `off (hand)` 不一样

`off` 表示"该在但没在"（`pp up --drift` 补），`off (hand)` 表示"有人特意停的"（`restart: unless-stopped`/`on-failure`
会记住手工 stop，`pp up <name>` 才会重新拉起）。`--json` 里对应 `"reason": "hand" | "never" | "policy"`。
半夜排查时这两个的答案完全不同，所以状态栏里分开写。

### `pp status --started`：它自己回来的，还是有人动过

```bash
$ pp status round --started
#  NAME   STATE    IDLE  RESTART  PID     STARTED
1  round  running  3s    always   123456  4m heal
2  wheel  running  9m    always   123457  2h up
$ pp status round
…
```

启动方会把自己的身份记进 `state.json` 的 `started` 字段（`why` = `up`/`restart`/`drift`/`autostart`/`heal`/`panel`，
`by` = `user@host#pid`）。意义在于半夜三点的那个问题：**"它是自己好的，还是有人动过？"** ——
`heal` 说明它反复在死、`autostart` 说明机器重启过、`up` 说明有人在操作。


### 排序与 `#` 列

`--sort name`（或配置里 `sort: name`）按名字排，`risk-01`/`risk-02`/`risk-pm` 会挨在一起，`risk-2` 排在 `risk-10` 前面。

`#` 列**始终是配置里的顺序**，不随排序变 —— 否则 `pp attach 3` 会悄悄指向另一台会话。
所以排序后表格会在 footer 里写明 `rows are sorted by name; # stays the config order`，
脚本里要稳的引用就用名字（`pp attach risk-pm`），名字永远不歧义。

### `--json` 的形状是契约

`test/json.test.js` 钉住：多一个键要改契约测试（并写进 release notes），少一个键直接红。
`pp cron dryrun --json` 是数组，每项 `{ id, target, plan | verdict }` —— 有 `plan` 的是一次
调度的完整判定（`targets[]` + `note`），没有 `plan` 的是"这一刻不做/不能做"的原因。

### `pp status --json`

```json
{
  "sessions": [ { "index": 1, "name": "web", "state": "running", "idle": "3m", "idleSeconds": 180, … } ],
  "drift":    { "down": 2, "unmanaged": 1, "stray": ["adhoc-shell"] }
}
```

`drift` 就是 footer 那两个数字的机器可读版本：`down` 用 `pp up --drift` 修，`unmanaged`/`stray` 用 `pp adopt` 修。
（0.32.0 起是对象；之前的版本直接打数组。）

### `pp send --all --dry-run "…"`

广播前先看名单。不敲任何键，只回答"谁会收、谁在忙被跳过"：

```
[dry-run] 9 target(s) — 6 would take it, 3 busy, 0 not running
  would send  bh-system-01
  busy        mango-release-01  mid-turn 55m — skipped, it would lose the thread
  busy        pp  mid-turn 2d — skipped, it would lose the thread
  not running risk-02

  text: probe
  nothing was typed; drop --dry-run to send
```

`busy` 的时长来自 `stallWatch`，与 `pp status` / `pp doctor` 同一套读数。

### `pp send --all "…"`

一个"正在想事"的 agent，是最容易让它丢掉上下文的方式。

```bash
$ pp send --all "stand up, I am back"          # 空闲的都收到
2 sent, 3 busy, 1 not running
$ pp send --all --dry-run "make check"         # 只看会敲什么
```

### 维护窗口里的破坏性操作：`drained` + `--yes`

`pp node drain <machine>` 之后，`pp up`、自启单元、`pp restart`、`cron --heal` 都不会去碰那台机器上的会话。
但"自动拉起"只是风险的一半 —— 另一半是有人（或脚本）在你打补丁时**停掉/删掉**了别人的会话：

```bash
$ pp down --force far-x
warning: far-x runs on a drained machine (far) — maintenance window: add --yes to stop it anyway

0 stopped, 0 not running. 1 needs --yes (drained machine).
$ pp down --force --yes far-x
1 stopped, 0 not running.
```

规则只有一条：**机器在 drain 状态时，`--force` 不再是万能钥匙，`down`/`rm` 都要额外加 `--yes`**。
被拦住的会话会计入 `pp status` 的 blocked 数，不会静默失败。

审计里分得更细：借 `--yes` 通过的停机记成 `down.forced`、删除记成 `rm.forced`，事后能查
"维护窗口里到底谁动了手"：

```bash
2m ago  down.forced  far-x — 1 stopped, 0 not running (drained machine, --yes given) (force)
```

### `pp up --drift`

只补缺口：配置里该在、现在没在的会话才起，已经在跑的完全不碰；没有缺口时输出
`nothing to start — the config and this machine agree`，所以可以放进 cron 或当成肌肉记忆反复敲。
手工停掉的会话（`unless-stopped`/`on-failure`）依旧保持停止，除非 `--force`。

```bash
$ pp status
8/8 running  6 nodes  config: /home/user/.pi/plus.yml
$ pp up --drift                # 只起 status 尾行里那些 `2 down`
```

### `pp logs <name|#...> | --all`

```bash
pp logs web                  # 一个会话的尾巴
pp logs web db --lines 40    # 两个会话，各一段，带 `── web` 头
pp logs --all --follow       # 全机器一条流，只打新增的行
```

`--follow` 不会把整屏重刷一遍：它记住上一次的抓取，找出"新出现的那几行"再打印
（管道/进度条那种只有最后一行在变的，也能看到变化）。按 `Ctrl-C` 退出。

`--stamp` 给每行加本地时间（`HH:MM:SS`），跟 `-f` 一起就是一份能贴进事故报告的时间线：

```bash
pp logs mango-release-01 -f --stamp
# 08:49:58 npm run build
# 08:50:09 error: EADDRINUSE
```

### `pp logs --grep`：一句话拿到那十行

```bash
$ pp logs mango-release-01 -n 800 --grep ERROR --context 2
…
step 41
step 42
ERROR boom at line 43
step 44
step 45
$ pp logs web --grep "EADDRINUSE|timeout" --ignore-case
```

`--grep <regex>` 只留命中的行，`--context N` 把每处命中扩成上下 N 行（等同 `grep -C`），
跳过的位置用 `…` 标出来 —— 贴进工单时能看出"这里还有东西没贴"。

两条讲究的语义：

- **匹配数打到 stderr**（`3 matches`），正文保持干净，可以直接 `| tee` 或重定向。
- **一条都没命中时退出码是 1**，于是 `pp logs web --grep ERROR || echo clean` 可以直接当检查用。

配 `-f` 时过滤器只作用于**新出现的行**（适合盯着一个已知错误等它复现）；`--stamp` 与它们可以叠加。

它盖的是 **pp 看到这行的时间**——tmux 不记程序写这行的时间。`-f` 时误差是一个
`--interval`（默认 2 秒）；不加 `-f` 时整段都是抓取时刻（等于只标了"什么时候抓的"）。

### `pp adopt [name|#...] [--all]`

把机器上**已经在跑、但不在配置里**的 tmux 会话反向登记进 `plus.yml`：

```bash
pp adopt                    # 列出可收养的（带 --dry-run 先看会写什么）
pp adopt web --dry-run
pp adopt --all              # 全部收编
pp adopt --all --node prod-01
```

从运行状态里取的信息：`cwd` 来自 pane 的当前目录、`agent` 来自 pane 在跑什么、
重启策略记 `unless-stopped`（你手动停掉的就保持停着）。**不会重启任何会话**——它们照旧跑，
配置从此开始描述它们。名字非法、与已有会话重名、pane 已经死掉的会被拒绝并说明原因。

如果 pane 跑的不是常见 agent（不是 `pi`/`bash`/`node` 之类），会提醒你 `--agent` 手动记一个，
免得下次 `pp up` 去执行一个跑不起来的命令。

### `pp tui` 只看列表，不看内容

面板现在只有两栏：左边会话，右边待办。**不再抓取 pane 内容** —— 终端内容该由 tmux 自己画，抓进面板既慢又贵（一个正在输出的会话，单帧就是 9KB）。

还有两件事值得知道：

- 客户端在看别的会话时，面板**完全不画**（它问 tmux 自己的 pane 是否可见）。往隐藏的 pane 里堆帧，就是你 `/pp-back` 回来觉得卡死的原因。
- 慢链路上单帧太久会自动拉长间隔（最多 10 秒），footer 写 `slow 3.0s`；`--static` 只在按键时重画，`--refresh 5` 自己定间隔。

```bash
pp tui --static            # 只在按键时画
pp tui --refresh 5         # 每 5 秒一帧
pp tui --once              # 打印一帧就退出
```

### `pp rename <会话> <新名字>`

把一个会话改名 —— tmux 与 `plus.yml` 一起改。

```bash
$ pp rename risk-01 risk-1
renamed risk-01 → risk-1
config: name, tmux_name updated
1 todo(s) now point at risk-1
```

远端会话在节点上执行（`ssh <node> pp rename …`），节点没有 `pp` 时退回 `tmux rename-session` 并明说。`tmux_name`、`pi_session_name`、待办、cron 任务里指向旧名的地方一起迁移；`pi_session` 不变，对话还是同一个。

### `pp fleet [--json]`

一台机器一条 `tmux list-sessions`，现场合并成一张表 —— 不缓存、不落盘。

```bash
$ pp fleet
SESSION           NODE     IDLE
bh-system-01      local    5m
api               n188     12s

2 sessions on 2 machines
```

连不上的机器显示 `unreachable: <名>`，而不是"没有会话"。

### `pp bind <会话> [--id <session-id>]`

把会话钉在**一个** pi 对话上。`pi --name` 只是给对话起名，不负责重开；没有 `--session-id` 时每次启动都是新对话、只是名字一样 —— 所以一个目录会堆一串 session 文件，重启看起来像失忆。

```
$ pp bind api
binding the newest of 2 conversations:
  01a20308-8d42-720b-84e7-76007e4d4e00  4m ago · 52 KB
api → 01a20308-8d42-720b-84e7-76007e4d4e00  (4m ago, 52 KB)
next restart returns to this conversation: pp restart api
```

同一个 cwd 上有多个 pi 会话时（一个仓库里两个 agent），靠**pi 记录的名字**区分：会话文件里的 `session_info` 事件记着 `--name` 给的名字，`bind` 挑名字匹配的最新那个。名字也对不上时它列候选并**拒绝**，等你用 `--id` 指认 —— 把两个 agent 接进同一个对话是数据破坏，不该猜：

```
$ pp bind api            # 没有任何会话文件带着这个名字时
error: /data/.../baohan-system has more than one pi session (bh-system-02) — pick the id by hand
  01a1e833-6bdc-7139-abc2-bdb6706d849d  6m ago · 18182 KB
then: pp bind bh-system-01 --id <id>
```

手查 id：`ls -t ~/.pi/agent/sessions/--<slug>--/*.jsonl`，看首行的 `id`。`pp doctor` 会一直留一条 `pi sessions`，直到每个 pi 会话都钉住。

| 选项 | 说明 |
| --- | --- |
| `--id <session-id>` | 钉这个对话，而不是最新的那个 |
| `--dry-run` | 只打印将要写入的内容 |

### `pp restart [name|#...]`

先 `down` 再 `up`，遵守 `restart` 策略：`restart: no` 的会话不参与裸 `restart`。

### `pp status [name|#...]`

状态表（别名 `ls`、`list`）。列：`#`、`NAME`、`[NODE]`、`STATE`、`IDLE`、`RESTART`、`PID`、`AGENT`、`CWD`、`PI SESSION`、`REMOTE-PI`
（`NODE` 只在配置里有 `nodes:` 时出现；`IDLE` 是这条会话最后一次有动静距今多久，
超过 `PP_STALE_MINUTES`（默认 30）分钟会标黄）。

`STATE` 取值：`running`、`attached`（有人正在看）、`dead`（pane 退出但被 `remain-on-exit` 保留）、`off`（配置了但没跑 / `restart: no` / 手动停过）。

选项：`--idle-over 30m`（只列安静超过这么久的会话，`s`/`m`/`h`/`d`）、
`--sort config|idle|name|role`（`idle` 是"最久没动优先"，`role` 把同一标签的会话挨在一起）、`--node <名>`、`--json`、`-q`。

`--idle-over` 和面板里 `s` 的琥珀 `!` 是同一件事的两种用法：一个看快照，一个盯着看。

```bash
pp ls --idle-over 30m     # 谁已经半小时没动静了
pp ls --sort idle | head -3
```

JSON：行对象数组，每行带 `activity`（epoch 秒）与 `idleSeconds`。

### `pp attach <name|#>`

进入会话（别名 `a`）。会话没跑会先启动。需要真终端（非 TTY 时 tmux 会报错）。`--dry-run` 打印 `tmux attach-session -t =<name>`。

### `pp logs <name|#> [-n N]`

打印 pane 最近 N 行（别名 `log`）。配了 `log:` 的会话也可以用 `tail -f` 看文件。

### `pp send <name|#> "文本"`

往 pane 里打字并回车（`--no-enter` 只打字）。本质是 `tmux send-keys`，适合给跑着的 agent 推提示词、回 `y/n`。默认立刻返回；要看结果用 `pp logs` 或下面的 `--until-idle`。

```bash
pp send backend "跑一下 npm test，失败就把报错贴出来"
pp send 3 --no-enter "git status"      # 先不执行
pp send backend "跑一下测试" --until-idle        # 等这一轮干完，把屏幕打出来
pp send backend "跑一下测试" --until-idle --timeout 120 --lines 80
```

`--until-idle` 把"发一句"变成阻塞调用：等到 agent 不再 Working，然后打印这段时间屏幕上多了什么（默认最多 `--lines` 行，40）。打印前会去掉两样噪音：底部的输入框（连同状态行）和**你刚发出去的那句话的回显** —— 那是你自己写的，再回放一遍只占屏幕。这是运维每天手搓的那个循环（发 → `logs -f` → 眯眼看）的命令化版本，所以在脚本里可以直接用：

```bash
out=$(pp send api "跑一遍 npm test，只回一行结论" --until-idle --lines 20)
echo "$out" | tail -3
```

退出码：会话在等待中退出 → 1（`exited while waiting`）；到 `--timeout`（默认 600 秒）还在跑 → 1（`still working after Ns`，并给出 `pp logs <name> -f`）。

### `pp update [--check]`

升级到最新发布版。先判断这份是从哪装的，再跑对应命令：

| 安装方式 | 判断依据 | 执行的命令 |
|---|---|---|
| npm 全局 | 脚本路径含 `node_modules/pi-farm/bin/pp.js` | `npm i -g pi-farm@<latest> --registry <url>` |
| git clone + `install.sh` | `<root>/bin/pp.js` 且 `<root>/.git` 存在 | `git -C <root> pull --ff-only` |
| 其它 | — | 不猜，打印手动升级提示并退出 1 |

```bash
pp update                 # 已是最新则什么都不做
pp update --check         # 0=最新，1=有新版（会打印将要执行的命令），2=查不到
pp update --dry-run       # 只打印命令
pp --json update --check
PP_NPM_REGISTRY=https://nexus.local/repository/npm-group pp update
```

升级不动配置文件、tmux 会话和自启单元——单元里的 ExecStart 指向安装路径，下次运行自然用新版。

### `pp alias [ls|add|rm]`

管理备用命令名。macOS 自带 `/usr/bin/pp`（ASN.1 工具），所以包内自带 `pifarm`、`pi-plus` 两个名字；`alias` 再加任意短名。

```bash
pp alias ls                        # 列出指向本 CLI 的软链 + 目录是否在 PATH
pp alias add pif                   # ~/.local/bin/pif → 本 CLI
pp alias add p --bin-dir /usr/local/bin
pp alias rm pif
pp alias ls --json
```

- 默认目录 `~/.local/bin`，可用 `$PP_BIN_DIR` 或 `--bin-dir` 覆盖；不在 PATH 时会提示怎么加
- 软链指向脚本本身，`npm i -g` 升级后别名自动跟随
- `add` 遇到同名**非软链**文件会拒绝（`--force` 才替换）；`rm` 遇到指向别的程序的软链也会拒绝
- `pp doctor` 的 `command name` 行会写明哪个名字是我们的、哪个是别人的，以及装在 PATH 上那份的版本

### `pp cron <子命令>`

把 prompt 或命令按时间送进会话。作业存在 `$XDG_STATE_HOME/pi-plus/cron.json`，
`crontab` 里只加一条每分钟的 `pp cron tick`（见 [docs/cron.md](cron.md)）。

| 子命令 | 说明 |
| --- | --- |
| `add` | 建作业：`--at`/`--in`/`--every`/`--cron` 四选一，`--session` 或 `--command` |
| `ls` | `ID / 目标 / 时间表 / 下次运行 / 次数 / 上次结果`（`--json` 可读） |
| `rm <id>` | 删作业 |
| `run <id>` | 立刻投递一次（调试，不动时间表） |
| `tick` | 到期就投递（crontab 每分钟调用的就是它；带锁，可重入） |
| `install` / `uninstall` | 往 crontab 写/删托管块（`--print` 只看） |
| `status` | crond 块、下次到期、日志路径 |
| `logs [-n N]` | 投递日志 |
| `reset <id>` | 清 `lastRun`（改过时间表后用） |

```bash
pp cron add --session backend --in 30m "看一下 CI"
pp cron add --session docs --cron "0 9 * * 1,2,3" "每周总结"
pp cron add --every 5m --command "curl -fsS localhost:8080/health"
pp cron ls
pp cron install
```

**克隆一个已经跑对的会话**：`pp new --from <会话|#>` 把 `node / cwd / role / agent / env / args / restart`
从源会话抄过来，只改你点名的东西（名字默认 `源名-2`）：

```bash
$ pp new --from risk-01 --save
risk-01 is taken, using risk-01-2
...
saved to /home/user/.pi/plus.yml
```

`-C` / `--node` / `--agent` / `--role` 仍然可以覆盖抄来的值。`--dry-run` 只打印将要执行的 tmux 命令，
并且 `--dry-run --save` **不会**写配置（只提示 `would append … to …`）。

### `pp`（不带参数）

第一屏：三行事实 + 六个习惯。不是 30 条命令的清单（那是 `pp help`）——打开终端想知道"现在怎么样"的人，
不该先读一份手册。

```bash
$ pp
pi-plus 0.67.0 · /home/user/.pi/plus.yml
9/9 running · 6 machines · 2 cron jobs
nothing needs you right now

  pp tui         the panel: what is running, enter a session, come back
  pp status      the table (--json for scripts, --watch to watch it)
  pp doctor --brief        what to do next, in the order that unblocks the most
  pp send        put one line in front of an agent
  pp logs -f     watch a session's output
  pp help        every command
```

第二行会变成 `3 off · 1 stopped by hand · 1 unmanaged — pp doctor --brief orders them` 这样的样子。只查本机（不 ssh），
所以可以当肌肉记忆用；`--json` 给脚本。

### `pp backup` / `pp restore`

改配置之前、升级之前、在别人的机器上折腾之前，先留一份。

```bash
$ pp backup
/home/you/.local/state/pi-plus/backups/2026-05-01T10-00-12-345  5 file(s), 42.1 KB
  plus.yml     3.1 KB
  state.json   1.1 KB
  cron.json    2.4 KB
  todos.json   612 B
  audit.log    34.8 KB

$ pp restore latest --dry-run
2026-05-01T10-00-12-345  →  2 file(s)
  plus.yml     will change
  sessions.api cwd: /srv/api -> /srv/api-v2
dry run — nothing was written
```

它是一份**普通目录拷贝**，不是压缩包 —— 凌晨用 `ls` 和 `cat` 就能看，`pp restore` 也不依赖任何东西。

- `--keep <n>`（默认 10）写完顺手清掉最旧的；`--list` 看已有；`--out <dir>` 存到别处（NAS、仓库）

`--verify [name]`（默认最新一份）逐个文件对比"实际大小"与"manifest 里记的大小"：
磁盘写满会截断文件、手清理会删掉文件，而 `--list` 显示的是 manifest **声称**的大小。

```bash
$ pp backup --verify
2026-05-01T10-00-12-345  5 file(s)
  plus.yml     ok
  state.json   bad — 12 B
error: plus.yml is 12 B but the manifest says 3.1 KB
```

`pp doctor` 的 `backup` 那一项跑的是同一个检查（最新一份）。
- 覆盖之前会**再备份一次**，所以"恢复错了"本身也能恢复
- 目录名带毫秒：同一秒内跑两次不会互相覆盖（早期版本会，导致"恢复回来的还是错的"）
- 恢复只改文件，不动 tmux；配置是问题根源时接着 `pp restart <name>`

pp 不会定时备份。没取的备份等于没有备份 —— 在改动之前跑，不是之后。

### `pp node <ls|show|add|rm|test|exec|ssh|drain>`

管别的机器：一个 `node` 就是一台能用 ssh 到的机器，登记一次之后，它的会话就能像本机会话一样
`up`/`down`/`attach`/`logs`/`send`/`tui`/`cron`（远端只需 sshd + tmux，不需要装 pp）。

```bash
pp node add prod-01 --host 10.0.0.11 --user deploy --identity ~/.ssh/id_ed25519
pp node add textbook --from-ssh-config textbook --password-env TEXTBOOK_PASS
pp node test prod-01        # 一次 ssh 往返：os / tmux / pi / pp / 负载 / 会话数
pp node ls                  # NODE TARGET PORT AUTH SESSIONS NOTE
pp node show prod-01        # 详情 + 谁在用（密码打码）
pp node rm prod-01          # 还有 session 指着它时拒绝，--force 才硬删
pp node exec prod-01 -- df -h /          # 一条命令，不占会话
pp node exec --all -- uptime             # 全机群巡检，逐台打印
pp node ssh prod-01         # 按登记的参数开交互式 ssh
pp new api --node prod-01 -C api --save   # 落到 /srv/apps/api
```

| 选项 | 说明 |
| --- | --- |
| `--host <ip\|dns>` | 地址，也可写 `user@host:port` |
| `--port <n>` / `--user <name>` | ssh 端口 / 登录用户 |
| `--identity <path>` | 私钥路径（`~`/`$VAR` 展开） |
| `--password <text>` | 密码写进配置（文件随后 chmod 600，会警告） |
| `--password-env <VAR>` | 从环境变量取密码；变量没设置直接报错 |
| `--from-ssh-config <alias>` | 抄 `~/.ssh/config` 里某个 Host 的 HostName/Port/User/IdentityFile |
| `--note <text>` | 备注，`pp node ls` 显示 |
| `--all` | `test`/`exec`：对所有节点 |
| `--timeout <秒>` | `exec`：单机超时（默认 60），超时按失败计 |
| `--parallel` | `exec`：所有选中机器同时跑（输出仍按顺序打印） |
| `--force` | `rm`：即使有会话在用它也删（会留下悬空引用） |
| `--dry-run` | `add`：只打印将写入的 YAML 块 |
| `--json` | 机器可读输出（`ls`/`show`/`test`/`exec`） |

密码通过 `sshpass -e`（环境变量 `SSHPASS`）交给 ssh，不进命令行，`ps` 看不到；
远端需要装 `sshpass` 才能用密码认证。`pp ls` 对每台机器只查一次 tmux，
连不上的机器整台标成 `unreachable`（红色），不会假装会话都停了。

完整说明见 [nodes.md](nodes.md)。

### `pp tui [选项]`

一屏内的控制面板：左列会话（配置顺序在前，再补 tmux 里多出来的），右列上半是待办、
下半是所选会话的 `capture-pane` 快照（只在那个 pane 真的打印了新东西时重新抓取，最多每秒一次 —— 空闲会话不发任何进程）。

**高度按内容分配**：待办框只占它需要的行数（空 3 行，每条 +1，最多 9 行），剩下的全给预览
——待办通常只有一两条，而预览是你真正在读的那块。

**窄屏自动堆叠**：宽度小于 88 列时改成竖排（会话 / 待办 / 预览），因为 1/3 的宽度只会把
会话名截断；这种模式下空待办框会整个隐藏，`--left` 也不再起作用。

| 键 | 作用 |
|---|---|
| `↑` `↓` / `k` `j` | 移动 |
| `Tab` | 切换列表 |
| `Enter` | 进入会话（tmux 内 `switch-client`，tmux 外 `tmux attach`） |
| `d` | 待办标记完成 |
| `[` / `]` | 左列变窄 / 变宽（每按一次 4 列） |
| `r` | 重绘 |
| `空格` / `b` | 整页向下 / 向上（`Ctrl-d` / `Ctrl-u` 同理；笔记本没有 PgUp/PgDn） |
| `PgUp` / `PgDn` | 与上面相同，键盘上有就用 |
| `←` / `→` | 上一栏 / 下一栏（`Tab` 同样是循环切换） |
| `-` / `+` | 待办框行数 -1 / +1（预览相应让出或收回） |
| `s` | 切换会话列表排序：配置顺序 → 最久没动优先 → 按名字（footer 会显示当前排序） |
| `/` | 输入子串过滤会话列表（名字/机器/状态）；输入时列表实时收窄并显示匹配数，Enter 保留、Esc 清除 |
| `f` | 暂停 / 恢复预览跟随（暂停时 footer 显示 `PAUSED`） |
| 行末 `2h` + `!` | 该会话已安静超过 `PP_STALE_MINUTES`（默认 30）分钟，琥珀色提醒 |
| `q` / `Esc` / `Ctrl-C` | 退出 |

页脚会数三样东西：`N off`（该起没起）、`N unmanaged`（在跑但配置里没有）、`N stuck`
（agent 在跑，但面板内容 `PP_STALL_MINUTES` 分钟没变化）。第三项只有它有意义：spinner 每几百
毫秒换一次字形，`window_activity` 永远是新的，只有比对**内容签名**才能把"正在想"和"卡住了"分开。
这项只看本机会话（远端归 `pp doctor`），并且每 10 秒才重算一次。

```bash
pp tui
pp tui --left 24              # 左列固定 24 列
pp tui --left 30%             # 左列占终端 30%
pp tui --once                 # 一帧输出后退出，不需要 tty
pp tui --socket work
```

| 选项 | 说明 |
|---|---|
| `--left <n\|N%>` | 左列宽度，默认终端的 34%（最小 18 列，右侧至少留 26 列）；运行时 `[` `]` 也能改 |
| `--diag` | 打印 tty / tmux 尺寸、是否在 alternate screen、这一帧能不能装下（怀疑"滚动/追加"时先跑它） |
| `--once` | 打印一帧就退出（管道里可用；`stdout` 不是 tty 时也只有这条路） |
| `--socket <name>` | 看哪个 tmux server |

非 tty 且没有 `--once` 时退出码 2，提示 `pp tui needs a terminal`。
右侧预览是快照：真正的终端由 tmux 接管，pp 不解析转义序列。

### `pp back`

面板自己记下它在哪个 tmux 会话/窗口/pane（`$XDG_STATE_HOME/pi-plus/panel.json`）。
从面板 Enter 进会话、办完事想回去时，`pp back`（或在会话里 `/pp-back`）用
`switch-client` 把当前 client 切回那个 pane —— 不 detach，所以终端不需要恢复保存的
一屏，也就不会多出一屏可滚的历史。面板已经不在了就清掉记录并提示重开。

```bash
pp back
pp back --dry-run        # 只打印要执行的 tmux 命令
```

### `pp todo <子命令>`

「谁在等我决策」清单。存在 `$XDG_STATE_HOME/pi-plus/todos.json`，pi 扩展在会话
弹出阻塞提示或跑完停在问句时自动写入（见 [docs/todo.md](todo.md)）。

| 子命令 | 说明 |
| --- | --- |
| `ls`（默认） | `# / 状态 / 等了多久 / 会话 / 类型 / 内容`；`--all` 含已完成，`--session` 过滤 |
| `add "文字"` | 手工登记（`--session` 指定；默认取当前 tmux 会话） |
| `attach <#>` | 进入该待办对应的会话，并标记 `seen` |
| `answer <#> "文字"` | **直接在该会话说出口并标记完成**（会话在忙或没跑时拒绝，`--no-enter` 只打字） |
| `done <#>...` | 标记完成（可一次多条） |
| `rm <#>...` | 从清单删掉（不是完成） |
| `clear` | 清掉已完成的；`--force` 连未完成的也清；`--offline` 只清"所属会话已不在"的那些（`ls` 里标 `(offline)`） |

引用可以写 `#`（1 起，按创建时间倒序，含已完成的行，编号稳定）或 id 前缀。

```bash
pp todo
pp todo attach 2
pp todo answer 2 "用方案 B，别动数据库"   # 就地答复，条目随即消失
pp todo answer 1 "方案 B" --node work-01   # 那条待办在别的机器上，就在那边回答

pp todo done 2 5
pp todo add "看一下这份迁移方案" --session backend
pp todo ls --all --json
```

### `pp doctor`（节选）

除了 node / tmux / 配置 / 自启，还会检查 **pi 扩展的版本**：扩展（`/pp-*` 命令）和 CLI 是两份
独立安装，版本很容易不一致，`✗ pi extension` 会直接给出对齐用的 `npm install --prefix …` 命令。

### `pp doctor`

环境体检：node / tmux / tmux server / pi 扩展版本 / 配置文件 / 节点注册 / 自启状态 / WSL 提示。
任何一项失败 → 退出 1。JSON：`{ "checks": [{name, ok, detail}], "warnings": [] }`。

`--nodes` 换成给**机群**体检：每台机器一次 ssh（并行发出），给出连通性、tmux 版本、负载、
`--json` 里每台机器带完整 `probe`。

```bash
pp doctor              # 这台机器
pp doctor --nodes      # 整个机群
```

### `pp init`

写示例配置到 `~/.pi/plus.yml`；`--local` 写 `./pi-plus.yml`；`--path <p>` 指定路径；已存在时报错（`--force` 覆盖）。

### `pp install [--watch N] [--print]`

装开机自启（别名 `autostart`）：Linux 用 systemd user unit，macOS 用 LaunchAgent。细节见 [autostart.md](autostart.md)。

- `--print` / `--dry-run`：只打印单元文件，不落盘
- `--watch [N]`：额外装一个 systemd timer（macOS 上是 `StartInterval`），每 N 秒跑一次 `up --reconcile`

### `pp uninstall`

停用并删除自启单元（不杀正在跑的会话）。

### `pp new [name]`

在当前目录（或 `-C <path>`）临时开一个会话，**不需要配置文件**。名字默认取目录名并规整成 tmux 安全字符，重名自动 `-2`、`-3`；显式给的名字重名则报错（`--force` 重建）。默认 `agent: pi`、`remote_pi_mode: env`。

```bash
pp new                                   # 名字 = 目录名
pp n api -C ~/code/api --attach          # 别名 n / create
pp new scratch --agent bash --log --save # 顺便写进配置
pp new api --node t114 -C /srv/api --save   # 开到别的机器上（-C 是那边的路径）
```

### `pp help [command]`

不带参数是总览；`pp help up` 与 `pp up --help` 等价；拼错会给出建议（`did you mean 'pp up'?`）。

### `pp version`

打印版本（等价 `-V`）。

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_PLUS_CONFIG` | 配置文件路径，优先级仅次于 `-c` |
| `TMUX_TMPDIR` | tmux socket 所在目录（`tmux -L` 时用） |
| `XDG_STATE_HOME` | 手动停止记录的位置（默认 `~/.local/state`） |
| `XDG_CONFIG_HOME` | 配置搜索路径之一（默认 `~/.config`） |
| `REMOTE_PI_DIRECT_CONFIG` | 由 `pp` 在 `remote_pi_mode: env` 时注入，不用手动设 |

## 常见组合

```bash
# 每天看一眼
pp doctor && pp doctor --brief && pp ls

# 只重启崩溃的那几个
pp ls --json | jq -r '.[] | select(.state=="dead") | .name' | xargs -r pp up

# 给某个 agent 推任务
pp send risk "把这周的日志异常整理成表格"

# 临时开一个实验目录，跑完删
d=$(mktemp -d) && pp new trial -C "$d" -a && pp down trial

# 让 risk-01 汇报，并把回复收进文件（最多等 2 分钟）

# 全体通知
```

## `pp node ls` 的 LIVE 与 CONFIG

| 列 | 意思 |
|---|---|
| `LIVE` | 那台机器上**现在**真在跑的 tmux 会话数（每台问一次，缓存 `PP_NODE_TTL` 秒，默认 15；`--fresh` 立即重问） |
| `CONFIG` | 配置里有多少会话 `node:` 指向它 |

`LIVE 9 / CONFIG 0` 不是空机器，是**没写下来**的机器：`pp adopt --node work-01`。
