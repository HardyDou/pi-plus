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

### `pp restart [name|#...]`

先 `down` 再 `up`，遵守 `restart` 策略：`restart: no` 的会话不参与裸 `restart`。

### `pp status [name|#...]`

状态表（别名 `ls`、`list`）。列：`#`、`NAME`、`STATE`、`RESTART`、`PID`、`AGENT`、`CWD`、`PI SESSION`、`REMOTE-PI`。

`STATE` 取值：`running`、`attached`（有人正在看）、`dead`（pane 退出但被 `remain-on-exit` 保留）、`off`（配置了但没跑 / `restart: no` / 手动停过）。

JSON：行对象数组。

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

### `pp check [name|#...]`

只校验配置，不碰 tmux。失败项进 stderr 并退出 1；`notes` 是提示（`restart: no`、手动停过、共享目录写同名等）。JSON：`{ "ok": true, "problems": [], "notes": [], "config": "..." }`。

### `pp doctor`

环境体检：node / tmux / tmux server / pi / 配置文件 / 自启状态 / WSL 提示。任何一项失败 → 退出 1。JSON：`{ "checks": [{name, ok, detail}], "warnings": [] }`。

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
