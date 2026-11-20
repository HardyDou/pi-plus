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

### `pp audit [target]`

```bash
pp audit                            # 最近 30 条改动，最新在最后
pp audit risk-01                    # 只这一个会话
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
2/3 running  1 down  1 unmanaged (stray-x) — pp adopt  config: ~/.pi/plus.yml
```

`down` = 配置里有、现在没在跑（`pp up` 能修）；`unmanaged` = 在跑、但配置里没有（`pp adopt` 能收）。
两数都为 0 时这行只显示 `N/N running`。`pp doctor` 里同一条信息叫 `drift`。

### `pp doctor --nodes` 的 `CONFIG` 列

`3/4` = 你为这台机器列了 4 个会话、3 个在跑；`+1` = 它上面还有一个没写进配置的会话。
两个符号分别对应 `pp up` 和 `pp adopt`。

### `pp status` 的 `CRON` 列

"有几个定时任务正对着这个会话"，`*` 表示有任务会往**每个**在跑的会话投递（例如
`pp cron add --all --every 10m "…"`）。会话行为诡异时（输入框里突然多出一段话、自己在跑），
先看这一列，再看 `pp cron ls`。只在真有任务时出现，平时不占宽度。

### `pp status` 的 `CLIENT` 列

有客户端连着会话时，表格末尾会多一列 `CLIENT`，形如 `user@/dev/pts/23`。杀会话之前先看这一列 ——
"别人正看着这个会话"和"没人管"是两件不同的事。

### `pp status`：`off` 和 `off (hand)` 不一样

`off` 表示"该在但没在"（`pp up --drift` 补），`off (hand)` 表示"有人特意停的"（`restart: unless-stopped`/`on-failure`
会记住手工 stop，`pp up <name>` 才会重新拉起）。`--json` 里对应 `"reason": "hand" | "never" | "policy"`。
半夜排查时这两个的答案完全不同，所以状态栏里分开写。

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
`--sort config|idle|name`（`idle` 是"最久没动优先"）、`--node <名>`、`--json`、`-q`。

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

### `pp node <ls|show|add|rm|test|exec|ssh>`

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
