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
pp restart [name|#...]     重启（遵守 restart 策略）
pp status [name|#...]      状态表，第一列是 # 序号（--json 机器可读；别名 ls/list）
pp attach <name|#>         进入；不存在则先启动
pp logs <name|#> [-n 200]  打印滚动输出
pp send <name|#> "文本"     往 pane 里打字并回车（--no-enter 不回车）
pp check                   校验配置
pp doctor                  环境诊断（含自启状态、WSL 提示）
pp init                    写示例配置
pp install [--watch N]     安装开机自启（别名 autostart）
pp uninstall               卸载自启
pp help [命令]             帮助（不带参数为总览）
pp version                 打印版本
```

全局选项：`-c/--config`、`--socket`、`--json`、`--dry-run`、`--force`、`-q`、`-v`、`-h`、`-V`。

`--reconcile` 是给自启/巡检用的：跳过被手动停止的 `unless-stopped` / `on-failure` 会话。
日常手动 `up` 不需要它。

配置文件查找顺序：

1. `-c/--config <path>`
2. `$PI_PLUS_CONFIG`
3. `./pi-plus.yml`、`./pi-plus.yaml`、`./plus.yml`、`./plus.yaml`
4. `~/.pi/plus.yml`、`~/.pi/plus.yaml`
5. `$XDG_CONFIG_HOME/pi-plus/config.yml`（默认 `~/.config/pi-plus/config.yml`）

## 开机自启

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

| 现象 | 处理 |
| --- | --- |
| `session "x" exited immediately` | `-v` 看实际命令；先用 `check` 确认 cwd/agent；临时加 `remain_on_exit: true` 看报错 |
| `tmux ... can't find pane` | 老版本 bug，升级；pane 目标需要 `=name:` 形式 |
| remote-pi 名字不对 | 看 `<cwd>/.pi/remote-pi/config.json` 的 `agent_name`；同名冲突时 broker 可能显示 `name#2` |
| 自启没生效 | `systemctl --user status pi-plus`；WSL 确认 systemd 开启；`pp doctor` |
| pi 找不到 | systemd 的 PATH 由 `install` 自动写入 node 所在目录；自定义路径用 `agent: /abs/path/pi` |

## 开发

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

Commands: `up`, `down`, `restart`, `status`, `attach`, `logs`, `send`, `check`,
`doctor`, `init`, `install`, `uninstall`. Options: `--config`, `--socket`,
`--json`, `--dry-run`, `--force`, `--watch`, `--lines`, `--quiet`, `--verbose`.

Zero runtime dependencies. Requires Node.js ≥ 18, tmux, and pi (any command
works via `agent:`).

## License

MIT © 2026 HardyDou
