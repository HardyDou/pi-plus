# pi-farm · 用一个 YAML 管住一农场 pi agent

[![ci](https://github.com/HardyDou/pi-farm/actions/workflows/ci.yml/badge.svg)](https://github.com/HardyDou/pi-farm/actions/workflows/ci.yml)

> Declarative tmux farm for [pi](https://github.com/badlogic/pi-mono) agents.
> One YAML file drives the **tmux session**, the **pi session id/name** and the
> **remote-pi mesh name** — and everything comes back after a reboot.

```
pi-farm.yml ──► tmux new-session -d -s backend -c ~/code/backend -- pi --name backend --session-id 1a2b3c4d
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
- **真正在后台跑**：`tmux new-session -d`，关掉终端不掉线；`pi-farm attach` 随时接管。
- **开机自启**：Linux systemd user unit / macOS launchd，`--watch` 还能定时巡检自动补活。
- **零依赖**：单文件 Node CLI，自带 YAML 子集解析器，不装 `js-yaml`、不需要 Python。
- **可脚本化**：`--json`、`--dry-run`、`--quiet`，退出码可用（`up` 有失败即 1）。
- **安全默认**：不经过 shell 拼接命令；tmux 名做白名单校验；重建前先 `check`。

## 安装

```bash
# 从 GitHub 安装（可执行命令直接就叫 pi-farm）
npm i -g github:HardyDou/pi-farm

# 或克隆后本地软链到 ~/.local/bin/pi-farm
git clone https://github.com/HardyDou/pi-farm.git
cd pi-farm && ./install.sh
# 直接运行也可以：node bin/pi-farm.js <command>
```

依赖：Node.js ≥ 18、tmux、pi（非 pi 的 agent 也可以，见 `agent` 字段）。

Shell 补全（可选）：

```bash
source completions/pi-farm.bash                     # bash
fpath+=(~/path/to/pi-farm/completions); compinit    # zsh
```

## 快速开始

```bash
pi-farm init                 # 生成 ~/.pi/farm.yml（或 --local 生成 ./pi-farm.yml）
$EDITOR ~/.pi/farm.yml
pi-farm check                # 只校验配置，不碰 tmux
pi-farm doctor               # 环境体检：node / tmux / pi / 自启
pi-farm up                   # 后台拉起所有 session
pi-farm status               # 看状态：tmux 名、pid、pi session、remote-pi 名
pi-farm attach backend       # 进入某个 session（没启动会先启动）
pi-farm up --dry-run -v      # 只打印将要执行的 tmux 命令
```

按名字操作，省略即全部（`enabled: false` 的会话会被跳过）：

```bash
pi-farm up backend docs
pi-farm restart backend
pi-farm down backend            # 只停一个
pi-farm down                    # 全部停掉
```

> 如果装了 `install --watch`，被单独 `down` 掉的会话会在下个巡检周期被拉回来；
> 不想这样就用不带 `--watch` 的 `install`，或临时 `systemctl --user stop pi-farm.timer`。

## 配置参考

```yaml
version: 1

# 可选：所有 session 跑在独立 tmux socket 上（等价于每条命令都加 --socket pi-farm）
# tmux:
#   socket: pi-farm

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
    enabled: true                 # false = 默认不启动（仍可 up <name> 单独拉起）
    log: ~/.pi/farm/backend.log   # 可选：pipe-pane 落盘
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
| `enabled` | `true` | `false` 时不参与裸 `up`/`restart`，但可 `up <name>` 单独启动 |
| `log` | 无 | `pipe-pane` 输出文件 |
| `remain_on_exit` | `false` | 保留 dead pane |

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
> `remote_pi_name` 会互相覆盖，`pi-farm` 会给出 warning；想让同目录多个 agent
> 各自有名字，用 `remote_pi_mode: env`（每个进程独立环境变量）。

> 小提示：`remote_pi_mode: config` 会在项目里生成 `.pi/remote-pi/config.json`，
> 建议加到全局 gitignore：`echo '.pi/remote-pi/' >> ~/.config/git/ignore`。

## 命令参考

```
pi-farm up [names...]        后台创建/启动（--force 重建已在跑的）
pi-farm down [names...]      停止
pi-farm restart [names...]   重启
pi-farm status               状态表（--json 机器可读）
pi-farm attach <name>        进入；不存在则先启动
pi-farm logs <name> [-n 200] 打印滚动输出
pi-farm send <name> "文本"   往 pane 里打字并回车（--no-enter 不回车）
pi-farm check                校验配置
pi-farm doctor               环境诊断
pi-farm init                 写示例配置
pi-farm install [--watch N]  安装开机自启
pi-farm uninstall            卸载自启
```

全局选项：`-c/--config`、`--socket`、`--json`、`--dry-run`、`--force`、`-q`、`-v`、`-h`、`-V`。

配置文件查找顺序：

1. `-c/--config <path>`
2. `$PI_FARM_CONFIG`
3. `./pi-farm.yml`、`./pi-farm.yaml`、`./farm.yml`、`./farm.yaml`
4. `~/.pi/farm.yml`、`~/.pi/farm.yaml`
5. `$XDG_CONFIG_HOME/pi-farm/config.yml`（默认 `~/.config/pi-farm/config.yml`）

## 开机自启

```bash
pi-farm install                 # 开机/登录时 up 一次
pi-farm install --watch 300     # 另外每 5 分钟巡检，挂了自动补
pi-farm install --print         # 只打印 unit/plist，不落盘
pi-farm uninstall
```

**Linux（systemd user unit）**：写入 `~/.config/systemd/user/pi-farm.service`，
`systemctl --user enable`。要开机即启动（不用先登录）需要一次 linger：

```bash
sudo loginctl enable-linger $USER
```

**macOS（launchd）**：写入 `~/Library/LaunchAgents/com.pi-farm.plist`，
`RunAtLoad` 登录即启动；`--watch` 用 `StartInterval` 定时巡检；日志在
`~/Library/Logs/pi-farm.log`。

**WSL2**：systemd 需要 `wsl.conf` 里 `[boot] systemd=true`（较新 WSL 默认开启）。
WSL 的 systemd user instance 在发行版启动时拉起，效果等同开机自启。

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

同理，把之前手动 `tmux new -s xxx` 起的会话迁过来：先 `pi-farm down`，
或者直接 `tmux kill-session -t xxx` 后 `pi-farm up`。

## 排障

| 现象 | 处理 |
| --- | --- |
| `session "x" exited immediately` | `-v` 看实际命令；先用 `check` 确认 cwd/agent；临时加 `remain_on_exit: true` 看报错 |
| `tmux ... can't find pane` | 老版本 bug，升级；pane 目标需要 `=name:` 形式 |
| remote-pi 名字不对 | 看 `<cwd>/.pi/remote-pi/config.json` 的 `agent_name`；同名冲突时 broker 可能显示 `name#2` |
| 自启没生效 | `systemctl --user status pi-farm`；WSL 确认 systemd 开启；`pi-farm doctor` |
| pi 找不到 | systemd 的 PATH 由 `install` 自动写入 node 所在目录；自定义路径用 `agent: /abs/path/pi` |

## 开发

```bash
npm test            # node --test，纯单元测试，不需要 tmux
node bin/pi-farm.js --help
```

代码结构：

```
bin/pi-farm.js     CLI 入口、参数解析
src/config.js      YAML → 归一化配置、argv 构建
src/yaml.js        零依赖 YAML 子集解析器
src/tmux.js        tmux 封装（含 dry-run 只读查询）
src/remote-pi.js   remote-pi 配置读写
src/autostart.js   systemd / launchd 模板与安装
src/commands.js    各子命令实现
```

## English

`pi-farm` keeps a farm of [pi](https://github.com/badlogic/pi-mono) coding
agents alive in tmux. Declare sessions in one YAML file; each session gets a
tmux session, a pi session (resumed by id or freshly created), a pi display
name, and a remote-pi mesh name — all defaulting to the same `name`.

```bash
npm i -g github:HardyDou/pi-farm
pi-farm init && $EDITOR ~/.pi/farm.yml
pi-farm check && pi-farm up && pi-farm status
pi-farm attach backend
pi-farm install --watch 300      # survive reboots, reconcile every 5 min
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
