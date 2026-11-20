# pp · 用一个 YAML 管住一农场 pi agent

[![ci](https://github.com/HardyDou/pi-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/HardyDou/pi-plus/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-farm.svg)](https://www.npmjs.com/package/pi-farm)

> Declarative tmux farm for [pi](https://github.com/badlogic/pi-mono) agents.
> One YAML file drives the **tmux session**, the **pi session id/name** and the
> **remote-pi mesh name** — and everything comes back after a reboot.

```
pi-plus.yml ──► tmux new-session -d -s backend -c ~/code/backend -- pi --name backend --session-id 1a2b3c4d
                                   │                    │              │                      │
                                   │                    │              │                      └─ 续接/新建 pi session
                                   │                    │              └─ pi 会话显示名 + remote-pi 名称
                                   │                    └─ 工作目录
                                   └─ tmux session 名（默认三个名字共用一个）
```

---

## 特性

- **一份 YAML，三层名字**：`tmux session` / `pi --name` / `remote-pi` 默认全部等于 `name`，也可分别覆盖。
- **续接或新建 pi session**：`pi_session` 填 session id 就续接（不存在则以该 id 新建），填 `.jsonl` 路径就 `--session`。
- **真正在后台跑**：`tmux new-session -d`，关掉终端不掉线；`pp attach` 随时接管。
- **开机自启**：Linux systemd user unit / macOS launchd，`--watch` 还能定时巡检自动补活。
- **零依赖**：单文件 Node CLI，自带 YAML 子集解析器，不装 `js-yaml`、不需要 Python。
- **可脚本化**：`--json`、`--dry-run`、`--quiet`，退出码可用（`up` 有失败即 1）。
- **安全默认**：不经过 shell 拼接命令；tmux 名做白名单校验；重建前先 `check`。
- **直接跟别的 agent 说话**：`pp mesh ls/send` 直连 remote-pi 的本地 broker，按会话名或跨机地址发消息、拿 ACK、等回复。
- **定时任务**：`pp cron add` 按「一次 / 每 N 分钟 / crontab 表达式」把 prompt 打进会话，或跑一条命令；装一个 crontab 行就管所有任务，重启后能补跑。
- **谁在等我**：`pp todo` 列出「哪个会话卡在问题上」，`pp todo attach 2` 直接进去；pi 弹提示或跑完停在问句时自动登记。
- **能查账**：`pp audit` 是每次改动的流水（谁、什么时候、把哪个会话停了/起了/发了什么），`--since 12h --action down` 就是"昨晚谁动的"。
- **多机器一张表**：`pp node add` 登记一台 ssh 能到的机器，会话写 `node: prod-01` 就跑到那台机器上——远端不用装 pp，`pp ls`/`tui`/`cron`/`todo` 一视同仁；机器的 `base_path`/`defaults` 让会话条目只剩两行。
- **机群体检**：`pp doctor --nodes` 并行 ssh 一遍，每台一行给出连通性、负载、uptime、会话数、磁盘、内存。
- **会话可搬家**：`pp mv <会话> --node <机器>` 停掉、改一行 `node:`、在新机器起来；`--local` 挪回来。
- **能收编**：`pp adopt --all` 把机器上已在跑、但没人写进配置的 tmux 会话登记进来（带 `--node` 收编别的机器上的）。

## 安装

```bash
# 从 npm 安装（包名 pi-farm，装完命令就是 pp）
npm i -g pi-farm

# 或直接从 GitHub 安装
npm i -g github:HardyDou/pi-plus

# 或克隆后本地软链到 ~/.local/bin/pp
git clone https://github.com/HardyDou/pi-plus.git
cd pi-plus && ./install.sh
# 直接运行也可以：node bin/pp.js <command>
```

依赖：Node.js ≥ 18、tmux、pi（非 pi 的 agent 也可以，见 `agent` 字段）。

### 升级

```bash
pp update            # 查最新版并升级（npm 全局装的就 npm i -g，git clone 的就 git pull）
pp update --check    # 只看有没有新版；有则退出码 1，适合脚本/定时任务
pp update --dry-run  # 只打印会跑的升级命令
```

> 内网镜像访问不到公共源时：`PP_NPM_REGISTRY=https://nexus.../npm-group pp update`；若报 `notarget`，是 npm 的 packument 缓存过期，`npm cache clean --force` 后重试。

### 命令名被别的程序占了？（macOS 自带 `/usr/bin/pp`）

macOS 上 `/usr/bin/pp` 是一个 ASN.1 转换工具，`pp ls` 会打出它的用法说明。除了 `pp`，安装时还会一起装两个名字：

```bash
pifarm ls        # 等价于 pp ls
pi-plus ls

pp alias add pif # 或者自己起个短名字（软链到同一个脚本，升级不会失效）
pp alias ls      # 看有哪些别名、目录是否在 PATH 里
pp alias rm pif
pp doctor        # 会提示 PATH 上的 pp 到底是不是我们
```

`install.sh` 也支持换名字：`PP_BIN_NAME=pifarm ./install.sh`（或 `PP_BIN_NAME="pp pif"`）。

> 若你的 `npm config get registry` 指向内网镜像（例如 Nexus），装不到这个包时显式指定公共源：
> `npm i -g pi-farm --registry https://registry.npmjs.org/`

Shell 补全（可选）：

```bash
source completions/pp.bash                     # bash
fpath+=(~/path/to/pi-plus/completions); compinit    # zsh
```

## 快速开始

```bash
pp init                 # 生成 ~/.pi/plus.yml（或 --local 生成 ./pi-plus.yml）
$EDITOR ~/.pi/plus.yml
pp check                # 只校验配置，不碰 tmux
pp doctor               # 环境体检：node / tmux / pi / 自启
pp up                   # 后台拉起所有 session
pp up --drift           # 只补没起来的（可反复敲，适合放 cron）
pp send --all "…"       # 一句话发给所有空闲会话（忙的跳过，不排队）
pp status               # 看状态：序号、tmux 名、pid、pi session、remote-pi 名
pp attach backend       # 进入某个 session（没启动会先启动）
pp attach 3             # 也可以直接给序号（pp ls 第一列的 #）
pp up --dry-run -v      # 只打印将要执行的 tmux 命令
```

按名字操作，省略即全部（`restart: no` 的会话不参与，见下文策略）：

```bash
pp up backend docs
pp restart backend
pp down backend            # 只停一个
pp down                    # 全部停掉
pp rm backend              # 删除：杀会话 + 删配置条目（会先问一次）
```

> 被单独 `down` 掉的会话会不会被拉回来，取决于它的 `restart` 策略——
> `unless-stopped` / `on-failure` 会记住这次手动停止，`always` 会在下个巡检周期回来。

## 临时开一个（不写配置）

不想动配置文件时，直接在当前目录（或 `-C` 指定的目录）开一个：

```bash
pp new                        # 名字 = 目录名（tmux 安全字符，重名自动加 -2）
pp new api -C ~/code/api      # 指定目录 + 名字
pp new scratch --agent bash --log -a   # 别的 agent、留日志、进去（简写 n）
pp n api --save               # 同时写进配置文件，重启后自动拉起
```

- 名字默认取**目标目录名**，会被规整成 tmux 安全字符（空格/中文/`.` → `-`）；目录名已被占用时自动 `-2`、`-3`
- 默认 agent 是 `pi`，自动带 `--name <会话名>`；remote-pi 名称同样取会话名，通过**环境变量**注入（`remote_pi_mode: env`），不会改写项目里的 `.pi/remote-pi/config.json`
- 常用选项：`-C/--dir`、`--agent`、`--log`、`--save`、`-a/--attach`、`--no-remote-pi`、`--force`、`--dry-run`
- `pp new` 不依赖任何配置文件；`--save` 会在**没有配置时新建** `~/.pi/plus.yml`（或 `-c` / `$PI_PLUS_CONFIG` 指向的路径）并追加这一条

## 跟别的会话说话（mesh）

`pp` 直连 remote-pi 的本地 broker（`~/.pi/remote/sessions/local/broker.sock`），
不需要 pi 进程、不需要配对，本机和其它电脑上的 agent 都能发：

```bash
pp mesh ls                                  # 谁在线（只读探测，不会让别人看到上下线）
pp mesh resolve backend                     # 配置里的会话 → mesh 地址 + 在线状态
pp mesh send backend "构建绿了，可以发版"      # 会话名/序号都行
pp mesh send 1 macbook:/Users/me/code/api@api "ping"   # 跨机直接写地址
pp mesh send all "5 分钟后重启机器"           # 广播
pp mesh send backend "跑一下测试" --reply 60000        # 等它回话，收到就返回
```

- 单个目标 = 单播并等 broker 的 ACK：`delivered to …`（收到）、`busy`（对方正在跑，
  消息被丢弃，稍后重试）、`denied`、超时；多个目标或 `all` = 组播，不等 ACK
- 加 `--reply <ms>` 会在 ACK 之后继续监听，把对方的回复打印出来（单播收到第一条就返回）
- 跨机地址形如 `macbook:/Users/me/code/api@api`；本机注册名默认 `pp-mesh`，用 `--as` 改
- 与 `pp send` 的区别：`pp send` 是往 tmux pane 里打字（对方当成"用户输入"），
  `pp mesh send` 是走 agent 之间的消息通道（对方收到 `[agent-network] message from …` 信封）
- broker 没起来时会明确报 `no mesh broker at …`；`pp mesh ls/resolve` 可离线用来看地址

## 别的机器上的会话（`pp node`）

一台机器一个节点，登记在**同一个配置文件**里；会话加一行 `node:` 就搬过去。
远端只需要 sshd + tmux（跑 agent 才需要 `pi`），**不用装 pp**。

```bash
pp node add prod-01 --host 10.0.0.11 --user deploy --identity ~/.ssh/id_ed25519
pp node test prod-01                 # tmux/pi/pp/负载/会话数，一次 ssh 往返
pp node exec prod-01 -- df -h /      # 一条命令，不占会话
pp node ls                  # NODE  TARGET  PORT  AUTH  SESSIONS  NOTE
```

```yaml
nodes:
  - name: prod-01
    host: 10.0.0.11
    user: deploy
    identity: ~/.ssh/id_ed25519
    tags: [prod, web]                # pp up --tag prod / pp node exec --tag web -- …
    guarded: true                    # pp down / pp rm 跳过它，除非 --force
  - name: textbook
    host: textbook.example.com
    password_env: TEXTBOOK_PASS      # 密码不落盘；变量没设置会直接报错

sessions:
  - name: prod-api
    node: prod-01                    # 这个会话在 prod-01 上
    cwd: /srv/api
  - name: textbook-web
    node: textbook
    cwd: /srv/web
```

之后 `pp ls` 的 NODE 列显示归属，`pp attach prod-api`、`pp logs prod-api`、
`pp send prod-api "..."`、`pp tui` 里的预览、`pp cron` 的投递全都自动走 ssh。
连不上的机器整台标成 `unreachable`，而不是假装里面的会话都停了。

密码走 `sshpass -e`（环境变量 `SSHPASS`），不进命令行，`ps` 看不到；
写在配置里的密码会让文件自动 `chmod 600` 并给你警告。详见 [docs/nodes.md](docs/nodes.md)。

## 在 pi 里用 `/pp-*`（扩展）

`pp` 自带一个 pi 扩展：把 tmux 的 `Ctrl-b s`、`Ctrl-b d` 变成斜杠命令，不用离开对话。

```bash
pi install npm:pi-farm     # 装进 ~/.pi/agent/settings.json，之后每个会话都有
pi -e npm:pi-farm          # 只想这次带着它
```

| 命令 | tmux 等价 | 作用 |
| --- | --- | --- |
| `/pp-ls` | `Ctrl-b s` | 列出所有会话，上下选择、回车切换 |
| `/pp-sw <会话>` | `Ctrl-b s` + 回车 | 直接切，支持唯一前缀与参数补全 |
| `/pp-quit` | `Ctrl-b d` | 断开当前终端，会话和 pi 继续跑 |
| `/pp-status` | — | 当前会话/窗口/pane/cwd/pi 会话 id/remote-pi 名字/pp 版本 |
| `/pp-peek [会话] [-n N]` | — | 看另一个会话最近 N 行输出，不切换 |

细节与排障见 [docs/extension.md](docs/extension.md)：

- 只操作"看着你"的那个 tmux client（`switch-client -c` / `detach-client -t`），没有 client 附着时给提示而不是报错；
- `/pp-status`、`/pp-peek` 用 `appendEntry` 渲染，**不占模型上下文**；`pi -p` 下改为写 stdout；
- 只在 tmux pane 里可用（靠 `$TMUX` 定位服务器）。

## 定时任务（`pp cron`）

三件事：**什么时候**、**送给谁**、**送什么**。调度和存储都在 pp 自己手里
（`$XDG_STATE_HOME/pi-plus/cron.json`），`crontab -l` 里永远只有一条 `pp cron tick`。

```bash
# 一次性：30 分钟后，往 backend 会话打一句 prompt
pp cron add --session backend --in 30m "看一下刚才那次 CI 的结果"

# 重复：每天早上 9 点（本地时间）
pp cron add --session docs --cron "0 9 * * *" "汇总昨天的提交，写到 docs/notes.md"

# 重复：每 5 分钟跑一条命令（不经过 pi）
pp cron add --every 5m --command "curl -fsS http://localhost:8080/health"

# 每周一、周二、周三 9 点
pp cron add --session risk-01 --cron "0 9 * * 1,2,3" "汇报昨天夜里跑的策略结果"
```

三种 schedule 选一个：

| 写法 | 含义 | 例子 |
| --- | --- | --- |
| `--at <ISO>` / `--in <时长>` | 只跑一次 | `--at 2026-11-21T09:00`、`--in 90m` |
| `--every <时长>` | 每隔一段时间 | `--every 30s`、`--every 2h` |
| `--cron "<表达式>"` | crontab 语法，**本地时间** | `"*/15 * * * *"`、`"0 9 * * 1-5"` |

`--session` 省略时用**当前 tmux 会话**（在 pi 里就是脚下这个）；`--command` 与 prompt
二选一。作业管理：

```bash
pp cron ls                 # 表：ID / 目标 / 时间表 / 下次运行 / 跑过几次 / 上次结果
pp cron run 3c764f         # 立刻跑一次（调试用，不动时间表）
pp cron rm 3c764f          # 删掉
pp cron logs -n 40         # 最近的投递记录
pp cron reset 3c764f       # 把 lastRun 清掉，让它按时间表重排
pp cron status             # crond 装没装、有没有到期作业、日志在哪
```

**得有人每分钟叫它一次**（`pp cron tick`，自带文件锁，重入会被跳过）：

```bash
pp cron install            # 往 crontab 写托管块：每分钟一次 + @reboot 一次补跑
pp cron install --print    # 先看看会写什么
pp cron uninstall          # 只删这个托管块，你自己的行一行不动
```

`@reboot` + 分钟级 tick 的组合负责**重启后补跑**：机器关机期间到期的作业会在开机后
第一次 tick 触发，前提是迟到时间没超过 `--catch-up`（默认 2 小时，`--catch-up 0` 表示
"迟到就别跑了"）。超过窗口的会被标成 `skipped: missed by 2h 30m`，而不是几小时后突然
往你的会话里打一句话。

在 pi 里还多一个工具 `schedule`：直接说「明天早上九点提醒我」就行，模型会自己把它换算成
绝对时间再建作业（同一个 `cron.json`）——斜杠命令模型看不见，工具才看得见。

细节见 [docs/cron.md](docs/cron.md)。

## 谁在等我（`pp todo`）

会话卡在一个问题上，你却在别的窗口 —— 这类「等你决策」的事会被自动收进一张清单：

```bash
pp todo                       # 需要我决策的
#  #  STATE  WAITED  SESSION     KIND     WHAT
#  1  new    3m      risk-01     settled  要我现在合并到 main 吗？
#  2  new    18m     backend     prompt   waiting: 选一个分支 — Enter to switch

pp todo attach 1              # 进入那个会话（顺手标记 seen）
pp todo done 1 2              # 处理完了
pp todo ls --all --json       # 连已完成的、机器可读
```

怎么判定「在等你」：

- **`prompt`** —— pi 弹出了阻塞式提示（`ui_prompt_start`：`select` / `confirm` / `input` / `editor`），会话确实停在那儿；
- **`settled`** —— 一轮跑完，最后一段话以问号结尾或含「请确认 / 要不要 / 是否需要」；
- **`manual`** —— `pp todo add "…" --session <name>`，或模型自己调用 `todo` 工具登记。

会话重新跑起来时，它自己的未完成待办会自动标记完成（你已经回答过了）。
噪音太大就 `export PP_TODO_SETTLED=off`（只记阻塞提示），想全都记就 `always`。

在 pi 里还有 `/pp-todo`：弹出清单，选中即切过去。

细节（数据文件、去重规则、边界）见 [docs/todo.md](docs/todo.md)。

## 一块屏看全部（`pp tui`）

会话多了以后，`pp ls` + `pp todo` + `pp attach` 来回敲就烦了。`pp tui` 把它们拼成一屏：

```
┌ sessions (7) ──────────────────────────┐ ┌ todo (2) ─────────────────────────────────────────────┐
│ 1 bh-system-01  running                │ │ 1. risk-01 — 要我现在合并到 main 吗？ (3m, settled)     │
│ 2 bh-system-02  running                │ │ 2. backend — waiting: 选一个分支 (18m, prompt)          │
│ 3 mango-release-01  running            │ └───────────────────────────────────────────────────────┘
│ 4 mano-dev-01  attached                │ ┌ preview: bh-system-01 ────────────────────────────────┐
│ 5 ops-5  running                       │ │ ● Bash(git log --oneline -5)                          │
│ 6 risk-01  running                     │ │   a1b2c3d fix: ...                                    │
│ 7 risk-02  running                     │ │ ⏳ Working...                                          │
└────────────────────────────────────────┘ └───────────────────────────────────────────────────────┘
 ↑↓ move   PgUp/PgDn scroll   Tab panel   Enter attach   d done   [ ] width   -/+ rows   f follow   q quit
```

- 待办框的高度跟着内容走（空 3 行、每条 +1、最多 9 行），预览拿走剩下的行；
- 终端窄于 88 列时自动竖排（会话 / 待办 / 预览），空待办框直接隐藏；
- 会话行末的 `3m` / `2h` 是这条会话最后一次有动静的时间（`#{session_activity}`），一眼看出谁在干活、谁已经晾了一下午；
- 安静超过 `PP_STALE_MINUTES`（默认 30）分钟的会话标成琥珀色、行末带 `!` —— "卡在 Working 一下午"那种最费时间的情况一眼就能看见（`pp ls` 的 `IDLE` 列、`--json` 的 `idleSeconds` 是同一份数据）；
- 从会话回到面板：`pp back` 或 `/pp-back`（`switch-client`，不 detach，不留残留画面）。

按键：

| 键 | 作用 |
|---|---|
| `↑` `↓` / `k` `j` | 在聚焦的列表里移动 |
| `PgUp` / `PgDn` | 整页翻动列表（光标跟着走，标题框不会跑丢） |
| `-` / `+` | 待办框少一行 / 多一行，预览把行让出来或收回去 |
| `s` | 切换排序：配置顺序 → 最久没动优先 → 按名字（footer 显示当前排序） |
| `f` | 暂停 / 恢复预览跟随（要读一段输出时按住它别动） |
| `Tab` | 切换列表（会话 ↔ 待办） |
| `Enter` | 进入（会话：在 tmux 里 `switch-client`，在 tmux 外 `tmux attach`）；从待办进则进它所属的会话 |
| `d` | 把选中的待办标记完成 |
| `D` | 补齐 drift：启动"该在却没起"的会话（等于 `pp up --drift`，不用离开面板） |
| `[` / `]` | 左列变窄 / 变宽（每按一次 4 列） |
| `r` | 立即重绘 |
| `q` / `Esc` / `Ctrl-C` | 退出 |

`Enter` 进去后 `Ctrl-b d` 回来，面板会自动重绘 —— 不退出 pp。

**它不是终端模拟器**：右侧下半部分是 `capture-pane` 的快照（每秒刷新），不是活终端。
真正接管终端的是 tmux，这也是它只有 ~400 行、不容易出玄学 bug 的原因。

渲染上还有一条硬规则：每一行都用绝对光标定位（`ESC[{row};1H`）重画、写完关掉自动折行。
这样即使某行宽度算错一个字符（中文、双宽 emoji 最常见），最多脏自己那一行，
不会让终端折行、多占一行、把整屏往上滚 —— 也就是不会出现"每刷新一次就多一帧"的样子。

```bash
pp tui                 # 交互
pp tui --left 24       # 左列固定 24 列（也能写 30%）
pp tui --once          # 打印一帧就退出（管道/CI 里也能用）
pp back                # 从任何会话切回这个面板（不 detach，不留残留画面）
pp tui -c ./pi-plus.yml --socket work
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 配置参考：**全部字段**、restart 策略矩阵、remote-pi 三种模式、完整示例、校验规则 |
| [docs/cli.md](docs/cli.md) | 命令行参考：全局选项、退出码、每个命令的用法/JSON/env |
| [docs/autostart.md](docs/autostart.md) | 开机自启：systemd 单元为什么必须有 `KillMode=none`、linger、timer、launchd、WSL 两侧配置、冷启动验证 |
| [docs/architecture.md](docs/architecture.md) | 内部实现：模块职责、`up` 数据流、名字解析、restart 状态机、tmux 目标规则 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 排障手册：按报错原文查（起不来、`can't find pane`、名字不对、自启没生效、attach 乱码…） |
| [docs/development.md](docs/development.md) | 开发指南：跑测试、改代码的规矩、测试分层、发布流程（含 npm staged publishing 的坑） |
| [docs/extension.md](docs/extension.md) | pi 扩展 `/pp-*` 与 `schedule` 工具：在会话里切 tmux、看别人的屏幕、断开连接、让 agent 自己排定时任务 |
| [docs/cron.md](docs/cron.md) | 定时任务：三种时间表、crond 托管块、补跑与迟到语义、时区、调试 |
| [docs/nodes.md](docs/nodes.md) | 多机器：`nodes:` 与 `node:` 字段、四种认证方式（密钥/agent/ssh config/密码）、`pp node add/ls/show/rm/test/ssh`、远端会话怎么跑、连不上怎么查 |
| [docs/todo.md](docs/todo.md) | 待办：三种来源、去重、`PP_TODO_SETTLED` 噪音控制、数据文件、边界 |

## 配置参考
```yaml
version: 1

# 可选：所有 session 跑在独立 tmux socket 上（等价于每条命令都加 --socket pi-plus）
# tmux:
#   socket: pi-plus

defaults:                 # 所有 session 的默认值
  agent: pi               # 可写成 "pi --verbose"，按空格分词、不经 shell
  args: []                # 追加参数：["--approve"]
  env: {}                 # 追加环境变量

sessions:
  - name: backend         # 必填；tmux / pi / remote-pi 的默认名
    cwd: ~/code/backend   # 必填；支持 ~ 与相对路径（相对配置文件所在目录）

    # ---- 以下全部可选 ----
    tmux_name: backend            # tmux session 名（默认 name）
    pi_session_name: backend      # pi --name（默认 name）
    remote_pi_name: backend       # remote-pi 名（默认 name；false/null 表示不设置）
    remote_pi_mode: config        # config | env | off（默认 config）

    pi_session: 1a2b3c4d          # pi session id；或 ~/.pi/.../x.jsonl 路径
    # pi_session_dir: ~/.pi/agent/sessions   # 可选，传给 --session-dir

    agent: pi                     # 覆盖 defaults.agent（bash / claude / "pi --verbose" 都行）
    args: ["--approve"]           # 追加参数
    env:                          # 覆盖/追加环境变量
      TZ: Asia/Shanghai
    restart: unless-stopped        # no | always | on-failure | unless-stopped
    log: ~/.pi/plus/backend.log   # 可选：pipe-pane 落盘
    remain_on_exit: false         # 可选：进程退出后保留 pane 便于看报错
```

字段速查：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `name` | 必填 | 会话逻辑名，也是另外三个名字的默认值 |
| `cwd` | 必填 | 工作目录，不存在则 `up` 直接报错 |
| `tmux_name` | `name` | tmux session 名，白名单 `[A-Za-z0-9][A-Za-z0-9_-]*` |
| `pi_session_name` | `name` | `pi --name`，会话列表里显示的名字 |
| `remote_pi_name` | `name` | remote-pi mesh 名，自动 sanitize（空格/斜杠→`-`） |
| `remote_pi_mode` | `config` | `config` 写 `<cwd>/.pi/remote-pi/config.json`；`env` 用 `REMOTE_PI_DIRECT_CONFIG`；`off` 不设置 |
| `pi_session` | 新会话 | session id（`--session-id`）或 `.jsonl` 路径（`--session`） |
| `pi_session_dir` | pi 默认 | `--session-dir` |
| `agent` | `pi` | 启动命令，支持带参数；非 `pi` 时不追加 pi 专用flag |
| `args` | `[]` | 追加到命令末尾 |
| `env` | `{}` | 注入环境变量 |
| `restart` | `always` | 拉起策略，取值见下节（对齐 docker compose） |
| `log` | 无 | `pipe-pane` 输出文件 |
| `remain_on_exit` | `false` | 保留 dead pane；`restart: no` 会自动开启 |

### restart 策略（和 docker compose 一致）

| 值 | 裸 `up` / 开机自启 | `--watch` 巡检 / 崩溃后 | 手动 `down <name>` 之后 |
| --- | --- | --- | --- |
| `always`（默认） | 启动 | 补起 | 下次 `up` / 巡检仍会启动 |
| `no` | 跳过 | 跳过 | —（只能 `up <name>` 手动启动） |
| `unless-stopped` | 启动 | 补起 | 记住这次停止，自启/巡检都不碰；`up <name>` 解除 |
| `on-failure` | 启动 | 只在 pane 进程异常退出（dead pane）时补起 | 同 `unless-stopped` |

判定规则：

- 不带名字的命令只处理 `restart != no` 的会话；`up <name>` / `restart <name>` 永远生效，
  并会清除"手动停止"记录。
- 会话存在但 pane 已经死了（agent 进程退出）时，`up` 对 `restart != no` 的会话会重建；
  `restart: no` 会保留 dead pane（自动打开 `remain-on-exit`），`status` 显示 `dead`，
  `pp logs <name>` 还能看到它最后吐出来的报错，`up <name>` 才会重建。
- 这和 compose 里 `docker compose ps` 还能看到 `Exited (1)` 的容器是一个意思。
- 手动停止记录存在 `$XDG_STATE_HOME/pi-plus/state.json`（默认 `~/.local/state/pi-plus/state.json`），
  按配置文件路径 + 会话名区分。
- 开机自启用的就是"巡检语义"：`pp up --config <cfg> --reconcile --quiet`，
  所以 `unless-stopped` / `on-failure` 在你手动停掉后不会在重启时自己回来。

```yaml
sessions:
  - name: backend
    cwd: ~/code/backend
    restart: always            # 常驻，挂了就补

  - name: experiment
    cwd: ~/code/exp
    restart: no                # 不参与自动拉起，只按需 pp up experiment
```

### 名字映射：一个名字，三处生效

| 想设置 | 字段 | 实际效果 |
| --- | --- | --- |
| tmux session | `tmux_name` | `tmux new-session -s <name>` |
| pi 会话名 | `pi_session_name` | `pi --name <name>`（续接旧会话也会改名） |
| remote-pi mesh 名 | `remote_pi_name` | 写 `agent_name` 到 `<cwd>/.pi/remote-pi/config.json` |

三个都不写时全部等于 `name`，所以最简配置只有两行：

```yaml
sessions:
  - { name: backend, cwd: ~/code/backend }
```

> remote-pi 的 `agent_name` 是**按目录**存的。同一 `cwd` 下多个 session 配不同
> `remote_pi_name`（且用默认的 `remote_pi_mode: config`）会互相覆盖，`pi-plus` 会给出
> warning；想让同目录多个 agent 各自有名字，用 `remote_pi_mode: env`（每个进程独立
> 环境变量），这样 `pp check` 不再告警。

> 小提示：`remote_pi_mode: config` 会在项目里生成 `.pi/remote-pi/config.json`，
> 建议加到全局 gitignore：`echo '.pi/remote-pi/' >> ~/.config/git/ignore`。

## 帮助

```bash
pp help                 # 总览：命令表、全局选项、restart 策略、配置示例
pp help up              # 单命令：用法、说明、选项、示例、相关命令
pp up --help            # 等价写法（-h 也可以）
pp help ls              # 别名也能查，自动解析到 status
pp help instal          # 拼错会给建议：did you mean 'pp help install'?
```

- `pi-plus` 不带参数 = `pp help`
- `-h` / `--help` 出现在任何位置都生效，已经写了命令就给该命令的帮助
- 帮助内容由 `src/help.js` 的 `COMMANDS` 表生成，总览、单命令、补全词表共用一份数据，
  加新命令时不会出现"文档忘了更新"

退出码：

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 运行时失败（会话启动失败、doctor 有检查项不通过） |
| `2` | 用法/配置错误（未知命令、未知选项、配置校验失败、找不到配置） |

## 命令参考

凡是接 `<name>` 的地方都可以写成 `pp ls` 的 `#` 序号（1 起，按配置顺序；
若真有会话叫这个名字，名字优先）：`pp attach 3`、`pp logs 3`、`pp down 2 5`。

```
pp new [name] [opts]       在当前目录/指定目录临时开一个（别名 n、create）
pp up [name|#...]          后台创建/启动（--force 重建已在跑的；别名 start）
pp down [name|#...]        停止
pp rm <name|#>...          删除（杀掉会话 + 从配置里删掉这一条）
pp restart [name|#...]     重启（遵守 restart 策略）
pp status [name|#...]      状态表，第一列是 # 序号（--json 机器可读；别名 ls/list）
pp attach <name|#>         进入；不存在则先启动
pp logs <name|#> [-n 200]  打印滚动输出
pp send <name|#> "文本"     往 pane 里打字并回车（--no-enter 不回车）
pp mesh ls|resolve|send    直连 remote-pi broker：看谁在线 / 查地址 / 发消息（--reply 等回复）
pp cron add|ls|rm|tick     定时把 prompt/命令送进会话（--in/--every/--cron；见下节）
pp todo [ls|attach|done]   谁在等我决策：列表 / 进去 / 完成（--all、--session）
pp node ls|add|test        管别的机器：登记节点、体检（os/tmux/pi/负载）、按参数 ssh
pp tui                     一块屏管所有会话和待办（左侧会话、右侧待办、下方预览）
pp check                   校验配置
pp doctor                  环境诊断（含自启状态、WSL 提示）
pp init                    写示例配置
pp install [--watch N]     安装开机自启（别名 autostart）
pp uninstall               卸载自启
pp alias [ls|add|rm]       换/加一个命令名（pp 被别的程序占用时用）
pp update [--check]        升级到最新发布版（npm / git 安装自动判断）
pp help [命令]             帮助（不带参数为总览）
pp version                 打印版本
```

全局选项：`-c/--config`、`--socket`、`--json`、`--dry-run`、`--force`、`--all`、`-q`、`-v`、`-h`、`-V`。

`--reconcile` 是给自启/巡检用的：跳过被手动停止的 `unless-stopped` / `on-failure` 会话。
日常手动 `up` 不需要它。

配置文件查找顺序：

1. `-c/--config <path>`
2. `$PI_PLUS_CONFIG`
3. `./pi-plus.yml`、`./pi-plus.yaml`、`./plus.yml`、`./plus.yaml`
4. `~/.pi/plus.yml`、`~/.pi/plus.yaml`
5. `$XDG_CONFIG_HOME/pi-plus/config.yml`（默认 `~/.config/pi-plus/config.yml`）

## 开机自启

完整说明（`KillMode=none` 的原因、linger、timer、launchd、WSL 两侧、冷启动验证）见 [docs/autostart.md](docs/autostart.md)。

```bash
pp install                 # 开机/登录时按 restart 策略 up 一次
pp install --watch 300     # 另外每 5 分钟巡检，挂了自动补
pp install --print         # 只打印 unit/plist，不落盘
pp uninstall
```

**Linux（systemd user unit）**：写入 `~/.config/systemd/user/pi-plus.service`，
`systemctl --user enable`。要开机即启动（不用先登录）需要一次 linger：

```bash
sudo loginctl enable-linger $USER
```

**macOS（launchd）**：写入 `~/Library/LaunchAgents/com.pi-plus.plist`，
`RunAtLoad` 登录即启动；`--watch` 用 `StartInterval` 定时巡检；日志在
`~/Library/Logs/pi-plus.log`。

**WSL2**：分两半，缺一不可。

1) WSL 内部（`pp install` 能做的部分）：
   - `/etc/wsl.conf` 里 `[boot] systemd=true`（较新 WSL 默认开启，可用 `cat /etc/wsl.conf` 确认）
   - `sudo loginctl enable-linger $USER`：不登录也能启动 user 服务
   - `pp install`：写 `~/.config/systemd/user/pi-plus.service` 并 enable

2) Windows 侧（**WSL 内部再怎么配也做不到**）：Windows 重启后 WSL 发行版本身不会自己
   启动，没有任何进程能替你触发它。必须由 Windows 上的一次动作把发行版拉起来，例如
   登录时执行（PowerShell，无需管理员）：

   ```powershell
   $p = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\pi-plus.vbs"
   Set-Content -Encoding ASCII $p 'Set s = CreateObject("WScript.Shell") : s.Run "wsl.exe -d <发行版名> -u <用户名> -e /bin/true", 0, False'
   ```

   把 `<发行版名>` 换成 `wsl -l -v` 里的名字（例如 `Ubuntu-24.04`）。也可以用任务计划
   程序建一个“登录时”任务，动作同样是 `wsl.exe -d <发行版名> -u <用户名> -e /bin/true`。

   原理：这条命令把发行版启动起来（systemd 成为 PID 1 并常驻），`--reconcile` 的
   `pi-plus.service` 随即按各会话的 `restart` 策略拉起 agent；命令本身会立刻退出，
   VBScript 用隐藏窗口跑，不闪黑框。

> 只配 WSL 内部、不配 Windows 侧：`wsl --shutdown` 或重启后不会有任何会话，直到你手动
> 打开一次终端。`pp doctor` 在 WSL 下会多打一行 `wsl` 提示这件事。

## 续接已有 pi 会话

```bash
# 1) 找到 session id：文件名就是 id
ls ~/.pi/agent/sessions/--<cwd编码>--/
# 编码规则：绝对路径里的 "/" 换成 "-"，例如 /home/me/code → --home-me-code--
# 也可以在目录里跑 `pi --resume` 从列表里挑，再按提示查看 id

# 2) 写进配置
sessions:
  - name: backend
    cwd: ~/code/backend
    pi_session: 1a2b3c4d      # id 不存在时 pi 会以该 id 新建
```

同理，把之前手动 `tmux new -s xxx` 起的会话迁过来：先 `pp down`，
或者直接 `tmux kill-session -t xxx` 后 `pp up`。

## 排障

完整版见 [docs/troubleshooting.md](docs/troubleshooting.md)，这里是最常见的几行：

| 现象 | 处理 |
| --- | --- |
| `session "x" exited immediately` | `-v` 看实际命令；先用 `check` 确认 cwd/agent；临时加 `remain_on_exit: true` 看报错 |
| `tmux ... can't find pane` | 老版本 bug，升级；pane 目标需要 `=name:` 形式 |
| remote-pi 名字不对 | 看 `<cwd>/.pi/remote-pi/config.json` 的 `agent_name`；同名冲突时 broker 可能显示 `name#2` |
| 自启没生效 | `systemctl --user status pi-plus`；WSL 确认 systemd 开启；`pp doctor` |
| pi 找不到 | systemd 的 PATH 由 `install` 自动写入 node 所在目录；自定义路径用 `agent: /abs/path/pi` |
| `pp ls` 打出一大段 ASN.1 用法 | 那是 macOS 自带的 `/usr/bin/pp`。用 `pifarm ls`，或 `pp alias add pif` 换个名字（见[安装](#命令名被别的程序占了macos-自带-usrbinpp)） |

## 开发

详见 [docs/development.md](docs/development.md)。

```bash
npm test            # node --test，纯单元测试，不需要 tmux
./test/e2e.sh       # 端到端冒烟测试（需 tmux/pi，约 3 分钟，会临时装一个 systemd unit 再删掉）
node bin/pp.js --help
```

代码结构：

```
bin/pp.js     CLI 入口、参数解析
src/config.js      YAML → 归一化配置、argv 构建
src/yaml.js        零依赖 YAML 子集解析器
src/tmux.js        tmux 封装（含 dry-run 只读查询）
src/remote-pi.js   remote-pi 配置读写
src/autostart.js   systemd / launchd 模板与安装
src/commands.js    各子命令实现
```

## English

`pi-plus` keeps a farm of [pi](https://github.com/badlogic/pi-mono) coding
agents alive in tmux. Declare sessions in one YAML file; each session gets a
tmux session, a pi session (resumed by id or freshly created), a pi display
name, and a remote-pi mesh name — all defaulting to the same `name`.

```bash
npm i -g github:HardyDou/pi-plus
pp init && $EDITOR ~/.pi/plus.yml
pp check && pp up && pp status
pp attach backend
pp install --watch 300      # survive reboots, reconcile every 5 min
```

Minimal config:

```yaml
version: 1
sessions:
  - name: backend
    cwd: ~/code/backend
    pi_session: 1a2b3c4d         # optional: resume (or create) this pi session
```

Name overrides: `tmux_name`, `pi_session_name`, `remote_pi_name`.
remote-pi mode: `config` (default, writes `<cwd>/.pi/remote-pi/config.json`),
`env` (`REMOTE_PI_DIRECT_CONFIG`), `off`.

Inside pi, the bundled extension adds `/pp-ls`, `/pp-sw <session>`, `/pp-quit`,
`/pp-status` and `/pp-peek [session] [-n N]` (install with `pi install npm:pi-farm`).

Commands: `up`, `down`, `restart`, `status`, `attach`, `logs`, `send`, `check`,
`doctor`, `init`, `install`, `uninstall`. Options: `--config`, `--socket`,
`--json`, `--dry-run`, `--force`, `--watch`, `--lines`, `--quiet`, `--verbose`.

Zero runtime dependencies. Requires Node.js ≥ 18, tmux, and pi (any command
works via `agent:`).

## License

MIT © 2026 HardyDou
