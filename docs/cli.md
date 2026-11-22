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

### `pp snapshot`

```bash
pp snapshot                # 会话表 + 定时任务 + 机器 + 审计尾部，一整块
pp snapshot --limit 20     # 底部多带些历史
pp snapshot --json | jq -r .text
```

只读、不 ssh、半坏也能用：坏掉的 `cron.json` 变成块里的一行（提示 `pp doctor --quarantine`）、
没有配置就直说。适合往 ticket / 群里贴一整段上下文。

### `pp handover [--since <窗口>] [--send <会话>] [--json]`

换班贴到群里的那一页。三段，按接手人需要的顺序：

```
handover  last 24h, up to 2026-11-22T06:39Z  ·  pp 0.73.19  ·  ~/.pi/plus.yml

changed 7 recorded — up ×4, down ×1, restart ×1, config.changed ×1
           2h ago  up             api
           5h ago  config.changed risk-01 — 1 change: sessions.risk-01 role: (absent) -> risk  (user@host#812)

now     9 session(s) configured, 9/9 local up
cron    3 job(s), tick installed, none late

human   nothing — nothing is off, stuck or late
```

- `changed` 来自 `pp audit`，**不含 `send`**（那是工作本身，会把要紧的七行淹掉）
- `now` = 配置期望多少、本地几个活着、定时任务数与 tick 是否还在
- `waiting` = 会话里等回答的问题（`pp todo` 里未完成的），按时间从旧到新，最多列 3 条，附 `pp todo attach <id>`
- `human` = 需要人做决定的：没起的、没登记的、卡住的、迟到的，每条都带修它的命令

只读，除了**交接**：`pp handover --send <会话>` 会把这一页**打进那个会话的 agent**（它正在思考时拒绝，避免在错误的位置插话），让下一班从事实开始，而不是面对一个空提示符 —— 凌晨三点最容易跳过的一步就是"把它粘过去"。

`--since` 与其他命令同一套窗口写法（`24h`、`90m`、`7d`），默认 24 小时。

### `pp audit [target]`

```bash
pp audit                            # 最近 30 条改动，最新在最后
pp audit risk-01                    # 只这一个会话
pp audit --role dev --since 1d      # 标签是 dev 的所有会话（按名或 tmux 名匹配）
pp audit --action down --since 12h  # 昨晚谁停了东西
pp audit --json --limit 200         # 交给 jq 汇总
pp audit --prune 90d                # 只留一个季度
```

一行一条：`<多久前> <动作> <目标> [on 机器] — <细节> (结果)`。append-only 写在
`$XDG_STATE_HOME/pi-plus/audit.log`（超过 2 MB 轮转成 `audit.log.1`）。`actor` 是
`user@host#pid`，所以定时任务投递和人在终端敲的命令能区分开；`--dry-run` 与只读
命令（`ls`/`status`/`check`）不写。

| 选项 | 说明 |
| --- | --- |
| `--limit N` | 显示最近 N 条（默认 30） |
| `--action VERB` | `up`/`down`/`restart`/`rm`/`send`/`cron.add`/`cron.rm`/`node.add`/`node.rm` |
| `--since 2h` | 只看这段时间之后（`30m`、`6h`、`3d`） |
| `--prune 30d` | 删掉更早的条目并报告留下多少 |
| `--file PATH` | 读另一份轨迹 |
| `--json` | 输出对象数组 |

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

### `pp status` 的尾行

```
2/3 running  2 down (1 cwd is gone, 1 stopped by hand)  1 unmanaged (stray-x) — pp adopt
```

`down` = 配置里有、现在没在跑（`pp up` 能修）；`unmanaged` = 在跑、但配置里没有（`pp adopt` 能收）。
两数都为 0 时这行只显示 `N/N running`。`pp doctor` 里同一条信息叫 `drift`。

括号里是**为什么**，按"多该动手"排序（最多显示三类，剩下的写 `N more`）：

| 说法 | 意思 | 下一步 |
| --- | --- | --- |
| `cwd is gone` | 本地工作目录不存在 | `pp check`，改 `cwd` 或建目录 |
| `machine unreachable` | 那台机器 ssh 不上 | `pp node test <name>` |
| `agent exited` | pane 还在、agent 退出了 | `pp logs <name>` |
| `on a drained machine` | 维护窗口里被有意按住 | `pp node undrain <name>` |
| `stopped by hand` | 有人手工停的 | `pp up <name>` |
| `not started` | 该在但没人起过 | `pp up` 或 `pp up --drift` |

`--json` 里同一份信息是 `drift.reasons: [{ why, count }]`，顺序同上；远程会话的 `cwd` 不在这里判断
（只在那台机器上存在），归到 `not started`，要看真因用 `pp check --remote`。

### `pp doctor --nodes` 的 `CONFIG` 列

`3/4` = 你为这台机器列了 4 个会话、3 个在跑；`+1` = 它上面还有一个没写进配置的会话。
两个符号分别对应 `pp up` 和 `pp adopt`。

### `pp status <name>`：它为什么在这里

```bash
$ pp status api
#  NAME  STATE    IDLE  RESTART  PID     AGENT  CWD       PI SESSION
1  api   running  12s   always   3798448 pi     /srv/api  api

last start 2m ago by heal (user@ops#1234) — pp audit --action up
restarted 3× in 20m — heal ×3 — pp logs api
```

`last start` 说明**这一次**是谁拉起来的；`restarted` 说明它**是不是一直在被拉起来**——前者在
一次快照里就有，后者只有历史能回答。三条一小时的重启，配合 `--heal` 的停手条件（3 次/小时）
基本就是"自愈在反复拉扯"，而"从没起来过"和"起来又死"的处理方式完全不同。

每个会话保留最近 5 条（`RESTART_KEEP`），来源标在 `why`：`up` / `autostart` / `restart` /
`heal` / `panel`。`--json` 里是 `restarts: [{ at, why, by }]`。

### `pp audit --action config.changed`：改了什么字段

```bash
$ pp audit --action config.changed --limit 3
2m ago   config.changed prod on prod — 1 change: +nodes.prod (changed)
5m ago   config.changed box on box — 1 change: nodes.box drained: (absent) -> true (changed)
9m ago   config.changed alpha — 1 change: -sessions.alpha (changed)
```

审计原本只说"谁执行了 `pp node add`"，而事后真正要回答的是"**它改了什么**"。所以每次写
`plus.yml` 的工具（`pp node add/rm/drain/undrain`、`pp adopt`、`pp mv`、`pp rm`、`pp new --save`）
都会在写盘前后各读一遍文件、做字段级 diff，把前 6 条差异写进同一条审计记录：

- 新增/删除：`+nodes.prod`、`-sessions.alpha`
- 字段改动：`sessions.api cwd: /srv/api -> /srv/api-v2`，删除写成 `-> (removed)`
- 嵌套映射（`env`、`defaults`）算一个值：`nodes.box defaults: {"restart":"no"} -> {...}`

写盘但内容没变（比如重复执行同样的 `node add`）不产生记录；`--dry-run` 也不产生。

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
first: pp up --drift — drift: off: parked, other — pp up
then:  pp clean — logs: cron.log 57.2 MB — shrink: pp clean
2 of 13 checks need attention — pp doctor
```

3am 的时候，"哪里不对"不如"**现在敲哪一条**"。所以每个检查都带着能修好它的命令，
`--brief` 按"解开多少东西"排序后只报前两条：配置 → node/tmux/pi → 命令名/扩展 → 自启 → cron →
drift → logs → stalls（最后这个要人去看，不是一条命令）。

`--json` 里每个 check 都带 `fix`，并多一个 `failed: ["drift","logs"]`，方便别的系统直接消费。
一切正常时只输出 `ok 14 checks, nothing to do`（退出码 0）；有问题退出码 1。

### `pp clean`：把 pp 自己写大的日志收回来

```bash
$ pp clean
shrank logger  2.9 MB → 64.0 KB  /tmp/logs/app.log
shrank cron.log  4.8 MB → 1.0 MB  ~/.local/state/pi-plus/cron.log

5.3 MB freed
$ pp clean --keep 512k --dry-run
```

每个 `log:` 会话都由 tmux 的 `pipe-pane` 往同一个文件里追加，pp 自己的 `info/cron/audit` 也一样——
**没人轮转**。忙起来的机器上它们会填满磁盘，而第一个症状是"什么都写不进去"，看起来像 pp 出了故障。
`pp clean` 把每个文件切成"最后 `--keep` 字节"（默认 2 MB）并告诉你省了多少。

三个刻意的做法：

- **保留尾部**：事故之后要看的是最新的那几百行，所以砍掉的是头部。
- **从整行开始**：裁切的起点对齐到换行符，不会留下半行（半行日志读起来像损坏）。
- **原地截断，不写新文件再改名**：`log:` 会话跑的是 `pipe-pane … cat >> file`，那个写入者手里攥着一个
  append fd；改名会让它继续写进一个已被 unlink 的 inode，新文件永远是空的 —— 日志看着还在，其实已经丢了。
  同一个 inode 上 `ftruncate` 只是把文件尾往前挪，写入者会接着新尾继续追加（0.51.0 的 e2e 里专门验证了
  inode 不变、截断后的新输出仍然写进同一个文件）。

`pp doctor` 在任一日志超过 50 MB 时给 `✗ logs <文件> <大小> — shrink: pp clean`。
远端会话的日志不在这里动：请在那台机器上跑 `pp clean`。

### `pp check --brief`：一行，一个退出码

```bash
$ pp check --brief
ok 8 session(s), 6 node(s), 0 problems
$ pp check --brief; echo "rc=$?"
1 problem: "gone": cwd does not exist: /srv/gone — pp check
rc=1
```

退出码：`0` 干净、`1` 有问题、`2` 用法错 —— 于是发版脚本里可以直接当闸门：

```bash
pp check --brief || exit 1
```

`--remote` 的节点检查是**并行**的（一台一次握手，不是串行六次），所以 `pp check --remote --brief`
在六台机器的配置上也是秒级。

### `pp check --remote`：让远端自己回答"这个路径存在吗"

默认 `pp check` 跳过跑在别的机器上的会话（路径只在那台机器上存在）。`--remote` 会对每台
节点握手一次，问两件事：

- 会话的 `cwd` 在那台机器上存在吗？
- `agent` 的第一个词在那台机器的 `PATH` 里吗？

```bash
$ pp check --remote
error: "bad": cwd does not exist on t114: /nope/does-not-exist
error: "bad": agent "definitely-not-installed" not found on t114
```

节点连不上时会单独报 `node "x" unreachable — …`，并让退出码变成 1，适合放进 CI/发版前检查。

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
last start 4m ago by heal (ops@dev#4121) — pp audit --action up
```

启动方会把自己的身份记进 `state.json` 的 `started` 字段（`why` = `up`/`restart`/`drift`/`autostart`/`heal`/`panel`，
`by` = `user@host#pid`）。意义在于半夜三点的那个问题：**"它是自己好的，还是有人动过？"** ——
`heal` 说明它反复在死、`autostart` 说明机器重启过、`up` 说明有人在操作。

`--started` 只是加一列；查单个会话时不加也会在表下多打一行。完整历史仍在 `pp audit --action up`。

### 排序与 `#` 列

`--sort name`（或配置里 `sort: name`）按名字排，`risk-01`/`risk-02`/`risk-pm` 会挨在一起，`risk-2` 排在 `risk-10` 前面。

`#` 列**始终是配置里的顺序**，不随排序变 —— 否则 `pp attach 3` 会悄悄指向另一台会话。
所以排序后表格会在 footer 里写明 `rows are sorted by name; # stays the config order`，
脚本里要稳的引用就用名字（`pp attach risk-pm`），名字永远不歧义。

### `pp status --json`

```json
{
  "sessions": [ { "index": 1, "name": "web", "state": "running", "idle": "3m", "idleSeconds": 180, … } ],
  "drift":    { "down": 2, "unmanaged": 1, "stray": ["adhoc-shell"] }
}
```

`drift` 就是 footer 那两个数字的机器可读版本：`down` 用 `pp up --drift` 修，`unmanaged`/`stray` 用 `pp adopt` 修。
（0.32.0 起是对象；之前的版本直接打数组。）

### `pp send --all "…"`

一句话发到所有会话（`--node`/`--tag` 收窄范围）。正在跑的会话会被**跳过**而不是排队 —— 把第二句话塞进
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
$ pp audit --action down.forced
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

### `pp mv <name|#> --node <machine> | --local`

把一条会话挪到另一台机器：在原来的地方停掉、改配置里那一行 `node:`、在新地方起来。
文件里其它行一个字节都不动。

```bash
pp mv backend --node prod-01          # 挪过去
pp mv backend --local                 # 挪回来
pp mv 3 --node prod-01 --cwd /srv/app # 顺便换目录（会在目标机上检查是否存在）
```

**挪不动的东西**：pi 的对话记录（jsonl）在旧机器旧目录旁边，新机器上是全新的一轮 ——
会话名、agent、remote-pi 名都不变，所以除了"历史"以外一切照旧。

拒绝的情况：目标机不可达、目标机已有同名 tmux 会话（`--force` 会替换）、
`--cwd` 在目标机上不存在。

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

往 pane 里打字并回车（`--no-enter` 只打字）。本质是 `tmux send-keys`，适合给跑着的 agent 推提示词、回 `y/n`。**不返回 agent 的输出**，要看结果用 `pp logs`。

```bash
pp send backend "跑一下 npm test，失败就把报错贴出来"
pp send 3 --no-enter "git status"      # 先不执行
```

### `pp mesh <ls|resolve|send>`

直连 remote-pi 的本地 broker（`~/.pi/remote/sessions/local/broker.sock`，可用 `$REMOTE_PI_HOME` 改根目录）：
不启动 pi、不注册常驻 peer，一条命令说完就走。

| 子命令 | 作用 |
|---|---|
| `ls` | 列出在线 peer。**只读探测**（`{"type":"list_peers"}`），不会让别人的 peer 列表出现上下线抖动 |
| `resolve [name\|#...]` | 配置里的会话 → mesh 地址（`<cwd>@<remote_pi_name>`）+ 在线状态；broker 不在也能用 |
| `send <target...> "文本"` | 以临时身份（默认 `pp-mesh`）注册、投递、等 ACK |

```bash
pp mesh ls                                   # # ADDRESS PC SESSION
pp mesh resolve backend risk-01              # backend → /srv/api@backend  online x1
pp mesh send backend "跑一下 npm test"        # delivered / busy / denied / timeout
pp mesh send 1 3 "10 分钟后重启"              # 多个目标 = 组播，不等 ACK
pp mesh send all "standup in 5"              # 广播
pp mesh send macbook:/Users/me/code/api@api "ping" --wait 2000
pp mesh send backend "报一下进度" --reply 60000   # 收到回复立刻打印并返回
pp mesh send api --body-json '{"task":"test","id":42}'   # 结构化消息
```

- 目标可以是会话名、`#` 序号、完整 mesh 地址（`<cwd>@<name>` 或 `macbook:/path@name`）、`all`/`broadcast`
- 单播会等 broker 的 ACK：`received` 成功；`busy` 表示对方正在跑一轮，**消息被丢弃**（用 `--no-wait` 或稍后重试）；`denied`；超时（消息可能仍会送达）
- `--reply <ms>`：ACK 之后继续监听 `re=<本次 id>` 的回信；单播拿到第一条就提前返回，组播/广播会一直收到窗口结束
- 发送内容默认是字符串（对方看到的就是这句话）；`--body-json` 发送任意 JSON，对方收到的是序列化后的 JSON 文本
- 地址后缀 `#N` 是 broker 对同 `(cwd, name)` 重复身份的自动去重，`livePeersFor` 会把它一并算作同一个会话
- 跨机投递走 broker leader 的 relay 桥，发送端不需要做任何配对

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

### `pp runbook [场景] [--markdown] [--json]`

这台机群**真的发生过**的事故，按"一个冷静的人会怎么走"的顺序写下来：先一条只读命令，再写清楚"健康的
答案长什么样"，最后才是那条会改变现状的命令。

```bash
$ pp runbook
the incidents this fleet has actually had — pp runbook <scenario>

  nothing-runs         Every session is gone
                       pp ls says 0/N running, tmux ls says nothing
  no-delivery          A cron job is not delivering
  ...
```

```bash
$ pp runbook disk-full
The disk is filling up
  pp doctor shows ✗ logs, writes start failing

Nothing rotates anything by design: …

 1  pp doctor --brief
    expect: ✗ logs  cron.log 57.2 MB — shrink: pp clean
 2  pp clean --dry-run
    expect: would shrink <file> 57.2 MB → 2.0 MB
 ...

when you are ready to change something: pp clean
```

场景可以按 id 或标题片段查（`pp runbook quiet`）。`--markdown` 输出整本手册 —— `docs/runbook.md`
就是它生成的（e2e 里有一条 `diff` 检查，所以文档不可能和代码走散）。pp 不会替你执行任何步骤。

## 输出的语法

一条规则，只用在"这一行是在告诉你要敲什么"的时候：

> **给人看的每一行，如果要指一条命令，就用 ` — ` 引出，且那是一条能直接敲的命令。**

```bash
"jb": restart: no, so a bare "pp up" skips it — pp up jb
✗ own files      cron.json 1 of 2 job(s) have no id or schedule — pp doctor --quarantine moves it aside
t114 has no tmux, so sessions cannot run there — apt install tmux (on t114)
3 off · 1 unmanaged — pp plan orders them
```

与之配套的两条：

- **不是每条都加建议。** 事实型的行（`"jb": writes /tmp/.pi/remote-pi/config.json`）说完就停，不要凑一句命令。
- **能一次说清的一条命令 > 三条建议。** `pp plan` 排序、`pp doctor --brief` 只给前两条，都是这个原则；散文在 3am 读不进去。

`--brief` / `plan` / `start` 是对同一批事实的三种密度：一行结论、按顺序的编号、三行摘要。

## `--json` 的形状是契约

脚本会解析这些输出，所以键名和类型被 `test/json.test.js` 钉住：**多一个键要显式改测试（并在 release notes 里说），少一个键立刻红**。
测试只钉形状不钉取值。

| 命令 | 顶层 | 备注 |
| --- | --- | --- |
| `pp status --json` | `{ sessions: [], drift: {} }` | `drift.down`/`drift.unmanaged` 是**数字**（配 `reasons` 解释），`drift.stray` 是名字列表 |
| `pp plan --json` | `{ steps: [], facts: {} }` | `steps[].{priority,title,command,why}` |
| `pp why --json` | `{ name, tmux, node, role, state, verdict, reason, cwd, agent, restart, lastStart, restarts, busy, cron, todos }` | `todos` **是数字**（未完成待办的条数） |
| `pp doctor --json` | `{ checks: [], failed: [], warnings: [] }` | `checks[].{label,ok,detail,fix}`；`failed` = 非 ok 的 label |
| `pp check --json` | `{ ok, problems, notes, config }` | |
| `pp cron ls --json` | 数组 | `cron ls[].{id,schedule,next,nextRun,runs,last}` |
| `pp node ls --json` | 数组 | `node ls[].{name,host,port,auth,tags}` |
| `pp audit --json` | 数组 | `audit[].{action,target,actor,result,ts}`，`node`/`detail` 视情况出现 |
| `pp role --list --json` | 数组 | `role list[].{role,count,sessions}` |
| `pp todo ls --json` | 数组 | `todo ls[].{id,session,kind,title,state}`（`body` 等视情况出现） |
| `pp runbook --json` | 数组 | `runbook[].{id,title,symptom,means,steps,fix}` |

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
  pp plan        what to do next, in the order that unblocks the most
  pp send        put one line in front of an agent
  pp logs -f     watch a session's output
  pp runbook     an incident happened: work it in order
  pp help        every command
```

第二行会变成 `3 off · 1 stopped by hand · 1 unmanaged — pp plan orders them` 这样的样子。只查本机（不 ssh），
所以可以当肌肉记忆用；`--json` 给脚本。

### `pp plan [--json]`

把 `doctor`、`why`、`status` 已经知道的事实汇总成**带顺序**的一串动作：每一步都是可以直接敲的一条命令，
外加"为什么它排这么靠前"。

```bash
$ pp plan
3 steps, in this order:

 1  pp node test t114
    reach t114 — ssh failed
    nothing on that machine can be fixed until ssh works
 2  pp up --drift
    start 2 session(s) that should be up
    off on this machine, t118
 3  pp clean
    cron.log is 57.2 MB
    nothing rotates it; a full disk breaks everything
```

排序是有理由的：连不上的机器会掩盖它上面的一切 → drained 的机器让 `pp up` 变成空操作 → 自启单元坏了
只影响下次重启 → 卡住的 agent 只影响"现在"。**只读**；`--json` 给脚本（`{ steps: [{priority,title,command,why}] }`）。

### `pp plan --node <机器>`

问的是另一个问题：不是"这台机群怎么了"，而是"**要让那台机器现在能接活，按顺序敲哪几条**"。

```bash
$ pp plan --node t114
t114 — what to type, in this order

2 steps, in this order:

 1  pp node undrain t114
    undrain t114 — 3 session(s) waiting
    a drained machine ignores pp up
 2  pp adopt --node t114
    adopt 2 session(s) that are not in the config
    running but unwritten: scratch@t114, try@t114
```

与整机群版的三点不同：

- 只问那台机器（一次 ssh），**不报告本机的事**（自启、扩展、本机日志与它无关）；
- 命令都带 `--node`，避免在九台机器的集群上敲错目标；
- "该起没起"用 `pp up --node <机器>`；"没写进配置"用 `pp adopt --node <机器>`；
- 机器没装 tmux 会说 `apt install tmux (on p202)`，而不是含糊的 "ssh failed"；名字写错会说 `pp node ls`。

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
- `pp restore` 先给 diff（就是 `pp audit --action config.changed` 那份），要 `--force` 才真写
- 覆盖之前会**再备份一次**，所以"恢复错了"本身也能恢复
- 目录名带毫秒：同一秒内跑两次不会互相覆盖（早期版本会，导致"恢复回来的还是错的"）
- 恢复只改文件，不动 tmux；配置是问题根源时接着 `pp restart <name>`

pp 不会定时备份。没取的备份等于没有备份 —— 在改动之前跑，不是之后。

### `pp why <会话|机器|标签|任务号> [--json]`

四种对象，同一个问题（"为什么是这样"）：

```bash
pp why api          # 一个会话
pp why --node t114  # 一台机器
pp why --role prod  # 一个标签下面的所有会话
pp why a59cfc       # 一个定时任务：它为什么没发出来
```

任务视图：

```
a59cfc  */10 * * * * · to mango-release-01
state    waiting: mango-release-01 is working — the next tick will deliver
schedule */10 * * * * · catch-up 2h
next     in 4m (10:40)
last run 6m ago — deferred
counts   ran 12× · skipped 0×
look     pp cron show a59cfc · pp logs mango-release-01
```

它把任务失声的四种方式分开说：**tick 不在 crontab**（`pp install`）、**上次失败**（`pp logs <会话>`）、
**错过超过 catch-up 窗口**（下一次照常跑）、**目标正在忙**（tick 会排队或跳过）。任务号可以只写前 3 位以上。


3am 的那一个问题："它为什么是这个状态？"——把配置、tmux、`state.json`、cron 文件里的既有事实读出来，
只打印一行结论。

```bash
$ pp why api
api  tmux:api · node:t114 · role:pm
state    off (drain) — machine t114 is drained — pp node undrain t114
cwd      /srv/api
agent    pi  pid -
restart  always
last start  12m ago by heal (bob@host#8123)
restarts    3× in 20m — heal
cron     a59cfc prompt (in 4m (10:41))
look     pp logs api · pp audit --target api · pp status api
```

结论按优先级给：机器不可达 → drained → 手工停过 → 在跑 → `restart: no` → 该在跑却没在跑。
**只读**，不改任何东西；`--json` 输出同样的事实（含 `reason`、`lastStart`、`restarts`、`cron`、`todos`）。

`--node <机器>` 问的是同一件事，对象是整台机器：能不能 ssh 上去、那边的 tmux 答不答话、这台机器是不是
在维护（drained）、以及它的每个会话是不是该起来。

```bash
$ pp why --node t114
t114  user@192.168.5.114 · tags:test,baohan
state    reachable — 1 of 2 session(s) down  (358ms)
machine  Linux 6.8.0-142-generic x86_64 · tmux v3.4 · pi installed
load     0.58 0.71 0.81 · up 50d
api      up   2m idle
web      down  restart: no — pp up web
look     pp node test t114 · pp status --node t114 · pp node exec t114 -- uptime
```

结论优先级：ssh 不通 → tmux 不应答 → 机器在维护 → 这台机器上压根没有配置会话 → 全起 → 有 N 个没起。

### `pp role <会话> [角色|-]`

给会话贴一个"它是干什么的"标签。角色是给**人**看的，不参与任何调度决策——`pp up` / `heal` / `--drift`
对带不带标签的会话处理完全一致（写错标签不会让 3am 的自愈行为变样）。

```bash
$ pp role risk-01 pm
risk-01  pm
next: pp status --role pm

$ pp status --role pm        # 只看 pm（大小写不敏感）
$ pp role risk-01            # 看当前标签
$ pp role risk-01 -          # 清除

$ pp role --list             # 我们到底用了哪些词？
  risk  2  risk-01, risk-02
  dev   1  web
2 roles · 1 session without one — pp role <name> <role>
```

标签是自由文本，所以"同一个东西四种拼法"是必然的失败模式。`pp role` 在你**创建**第二个拼法时
就会拦住：

```bash
$ pp role web DEV
error: there is already "dev" — labels differ by case ("DEV" would be a second one)
use the one you have: pp role web dev   (or --force to add "DEV")

$ pp role web dve
error: "dve" is one edit away from "dev" — did you mean it?
pp role web dev   (or --force to add "dve" as a new label)
```

`dve` 这种相邻字符颠倒也算一次编辑（Levenshtein 会算成两次，那就漏掉了最常见的输入错误）。
两个字以上的标签才启用这个近似判断 —— `pm`/`po`、`qa`/`qe` 本来就只差一个字符，拦它们只会烦人。
`--force` 永远可以真的新建一个标签。

`pp role --list` 是 `--role` 的另一半：它把**实际写过**的标签连同成员一起列出来（按用得多少排序），
末尾告诉你还有几个会话没标签。`--json` 给机器：`[{ "role": "risk", "sessions": ["risk-01", "risk-02"], "count": 2 }]`。

`--role` 也能收窄任何"批量"动作（过滤发生在 `selectSessions`，与 `--node`/`--tag` 同一个关卡）：

```bash
$ pp send --role pm "站会十分钟后开始"   # 只发给 pm，忙的会跳过
$ pp logs --role dev -f                  # 只看开发会话
$ pp up --role qa                        # 只拉起 qa
$ pp restart --role ops
```

任一会话带 role 时 `pp status` 才多出 `ROLE` 列（没有就保持老表格宽度）；`pp tui` 把角色跟在名字后面，
`/` 过滤也会匹配角色。写入配置文件里的 `role:` 字段，并记进 `pp audit --action config.changed`。

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
pp node add prod-01 --base-path /srv/apps --default-restart unless-stopped
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
| `--base-path <dir>` | 这台机器的根目录：会话写相对的 `cwd` 时拼在它下面 |
| `--default-agent <cmd>` | 这台机器上会话的默认 agent（会话自己写的优先） |
| `--default-restart <策略>` | 默认 restart：`no`/`always`/`on-failure`/`unless-stopped` |
| `--default-remote-pi-mode <模式>` | 默认 `remote_pi_mode`：`config`/`env`/`off` |
| `--default-role <label>` | 这台机器上会话的默认角色（远端会话靠它进入 `--role` 的各种扇出） |
| `--all` | `test`/`exec`：对所有节点 |
| `--tag <name>` | 给节点打标签（可重复，累加）；`ls`/`test`/`exec`/`up`/`down`/`restart` 用它选机器 |
| `--timeout <秒>` | `exec`：单机超时（默认 60），超时按失败计 |
| `--parallel` | `exec`：所有选中机器同时跑（输出仍按顺序打印） |
| `--guard` / `--no-guard` | 给机器加锁/解锁：加锁后 `pp down`/`pp rm` 跳过它的会话，除非 `--force` |
| `--force` | `rm`：即使有会话在用它也删（会留下悬空引用） |
| `--dry-run` | `add`：只打印将写入的 YAML 块 |
| `--json` | 机器可读输出（`ls`/`show`/`test`/`exec`） |

密码通过 `sshpass -e`（环境变量 `SSHPASS`）交给 ssh，不进命令行，`ps` 看不到；
远端需要装 `sshpass` 才能用密码认证。`pp ls` 对每台机器只查一次 tmux，
连不上的机器整台标成 `unreachable`（红色），不会假装会话都停了。

完整说明见 [nodes.md](nodes.md)。

### `pp tui [选项]`

一屏内的控制面板：左列会话（配置顺序在前，再补 tmux 里多出来的），右列上半是待办、
下半是所选会话的 `capture-pane` 快照（每秒刷新一次）。

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
| `PgUp` / `PgDn` | 整页翻动列表 |
| `-` / `+` | 待办框行数 -1 / +1（预览相应让出或收回） |
| `s` | 切换会话列表排序：配置顺序 → 最久没动优先 → 按名字（footer 会显示当前排序） |
| `/` | 输入子串过滤会话列表（名字/机器/状态）；输入时列表实时收窄并显示匹配数，Enter 保留、Esc 清除 |
| `f` | 暂停 / 恢复预览跟随（暂停时 footer 显示 `PAUSED`） |
| 行末 `2h` + `!` | 该会话已安静超过 `PP_STALE_MINUTES`（默认 30）分钟，琥珀色提醒 |
| `q` / `Esc` / `Ctrl-C` | 退出 |

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
| `done <#>...` | 标记完成（可一次多条） |
| `rm <#>...` | 从清单删掉（不是完成） |
| `clear` | 清掉已完成的；`--force` 连未完成的也清 |

引用可以写 `#`（1 起，按创建时间倒序，含已完成的行，编号稳定）或 id 前缀。

```bash
pp todo
pp todo attach 2
pp todo done 2 5
pp todo add "看一下这份迁移方案" --session backend
pp todo ls --all --json
```

### `pp check [name|#...]`

只校验配置，不碰 tmux。失败项进 stderr 并退出 1；`notes` 是提示（`restart: no`、手动停过、共享目录写同名等）。JSON：`{ "ok": true, "problems": [], "notes": [], "config": "..." }`。

### `pp doctor`（节选）

除了 node / tmux / 配置 / 自启，还会检查 **pi 扩展的版本**：扩展（`/pp-*` 命令）和 CLI 是两份
独立安装，版本很容易不一致，`✗ pi extension` 会直接给出对齐用的 `npm install --prefix …` 命令。

### `pp doctor`

环境体检：node / tmux / tmux server / pi 扩展版本 / 配置文件 / 节点注册 / 自启状态 / WSL 提示。
任何一项失败 → 退出 1。JSON：`{ "checks": [{name, ok, detail}], "warnings": [] }`。

`--nodes` 换成给**机群**体检：每台机器一次 ssh（并行发出），给出连通性、tmux 版本、负载、
uptime、会话数、磁盘、内存，适合"哪台快满了"这种问题。可用 `--node <名>` / `--tag <标签>` 收窄，
`--json` 里每台机器带完整 `probe`。

```bash
pp doctor              # 这台机器
pp doctor --nodes      # 整个机群
pp doctor --nodes --tag prod
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
| `REMOTE_PI_HOME` | remote-pi 的状态根目录（默认 `~/.pi`），`pp mesh` 用它定位 broker socket |

## 常见组合

```bash
# 每天看一眼
pp doctor && pp check && pp ls

# 只重启崩溃的那几个
pp ls --json | jq -r '.[] | select(.state=="dead") | .name' | xargs -r pp up

# 给某个 agent 推任务
pp send risk "把这周的日志异常整理成表格"

# 临时开一个实验目录，跑完删
d=$(mktemp -d) && pp new trial -C "$d" -a && pp down trial

# 让 risk-01 汇报，并把回复收进文件（最多等 2 分钟）
pp mesh send risk-01 "把今天的异常日志总结成 5 条" --reply 120000 > risk-report.txt

# 全体通知
pp mesh send all "我要重启这台机器，5 分钟后回来"
```
