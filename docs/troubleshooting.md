## `/pp-back`（或别的 `/pp-*`）不存在

CLI 和 pi 扩展是**两份安装**：`pp` 走 `npm i -g pi-farm`，`/pp-*` 走 pi 自己的
`~/.pi/agent/npm`，两者版本可以差很远。表现就是命令明明发了新版，pi 里还是旧的（甚至没有）。

1. `pp doctor` 看 `pi extension` 一行：会直接写出扩展版本与本机 CLI 版本，不一致时给出修好的命令。
2. `pi install npm:pi-farm` 对**已安装**的包是空操作（`up to date`），不会升级；要指定版本：

   ```bash
   npm install --prefix ~/.pi/agent/npm pi-farm@<cli 版本> --registry https://registry.npmjs.org/
   ```

   （`--registry` 不能省——内网镜像通常滞后，会报 `notarget`。）
3. 装完在 pi 里 `/reload`（或重启 pi），再 `/pp-status` 看 `pp` 与 `pp cli` 两行的版本。

## `pp status` 说 `N unmanaged` / `N down`

- **`down`**：配置里有、现在没在跑。`pp up` 起来；若是你手动停的（`pp down`），它记在
  `$XDG_STATE_HOME/pi-plus/state.json` 里，重启不会自己回来。
- **`unmanaged`**：在跑、但配置里没有。`pp adopt --all` 收编，或 `pp down <name>` 停掉。
- 两个数归零，说明"配置描述的就是机器现状"。`pp doctor` 里同一条检查叫 `drift`。

## 定时任务的提示词只被填进输入框，没有发出去

根因是 **pi 在一轮对话跑完之前不收输入**：它把打进编辑器的东西当成"待发送草稿"存着，等这一轮结束
才发出去。于是一个长时间不结束的会话（卡住的工具调用、跑很久的子 agent）会让每 10 分钟一次的定时
任务都把提示词**再堆一份**到输入框里，而 `Enter` 看起来毫无作用——它确实没作用，内容只是在排队。

现在的行为：

- 投递前先看面板上有没有 **`⠋ Working`** 这类转圈行。有就**不打字**，记成
  `deferred: <session> is working — the next tick will deliver`，下一分钟再来；不占用 `runs`、
  不推进 `lastRun`，所以同一个调度会自然再到期。
- 输入框里已经有同一段提示词（上一次没来得及发出去的）时，**不再重复打字**，只补 `Enter`。
- 发送是否成功按"**输入框是否被清空**"判断（`editorDraft`：屏幕上最后两条 `────` 之间的内容），
  而不是"屏幕有没有动"——忙碌的 agent 一直在动，屏幕变化说明不了任何事。四次 `Enter` 之后文字
  还在框里，才记成失败，并把面板最后两行写进 `lastStatus`（`pane showed: …`）。

手工补救：`pp send <session> "<提示词>"`；想立刻清空输入框里堆着的草稿，在目标会话里按一次
`Ctrl+C`（pi 的"清空编辑器"，连按两次才会退出）。

如果一个会话的 `⠋ Working` 几个小时都不消失，那不是 `pp` 的问题：看 `pp attach <session>` 里
卡住的那一步（常见是某个工具调用没返回）。

## `pp status` 里 `off` 和 `off (hand)` 有什么不同

`off` = 该在但没在（`pp up --drift` 补起来）。`off (hand)` = 有人特意停的：
`restart: unless-stopped` / `on-failure` 的会话被手工 `pp down` 过，pp 记着这件事，
所以自启和 `--drift` 都不会擅自把它拉起来。要它回来就 `pp up <name>`（会清掉那个记号）。
`--json` 里对应 `"reason": "hand" | "never" | "policy"`。

## 面板底部出现 `3 off · 1 unmanaged`

那两个数字就是 `pp status` 尾行那对儿的缩写：`off` 是配置里该在却没起的会话（`pp up --drift` 补齐），
`unmanaged` 是机器上跑着但配置里没写的会话（`pp adopt` 收编）。`pp tui --once` 打印的那一帧也一样。

## `pp tui` 会滚屏 / 看起来每刷新一次就多一帧

按时间排查（每条都能定位到底是谁在滚）：

```bash
pp tui --diag
```

它会打印四件事：

1. `tty` 尺寸（`process.stdout` 报的）和 `pane size`（tmux 报的）——两者不一致说明 SSH 侧的窗口尺寸是旧的；
2. `client sees` —— **tmux 窗口比客户端屏幕大**时，多出来的行在屏外，tmux 允许你滚过去看，这跟面板无关；`--diag` 会直接给修复命令（通常 `tmux set -g window-size latest`）；
3. `alternate on=0` —— 说明这个 pane 没进 alternate screen（`tmux set -w alternate-screen off`，或终端不支持 `1049`），旧帧就会留在 scrollback 里；
4. `verdict` —— 这一帧要不要超出屏幕；`fits` 就说明面板自己不会滚。

面板本身的保证（0.9.1 起）：每行用绝对光标定位重画、面板运行时关掉自动折行、行宽按终端裁剪、绝不在最后一行之下落笔、绘制行数取 `min(tty, pane, client)`。

# 排障手册

按「你看到的原文」查。每条都附上验证命令。

## 节点类（`pp node`）

| 现象 | 原因与做法 |
| --- | --- |
| `pp node test` 报 `password_env PP_X is not set` | 密码变量在当前环境里没有值。`export PP_X=…`，或改用 `--identity`。pp 不会偷偷退回去用密钥。 |
| `node "x" uses a password, which needs sshpass` | 远端/本机没装 `sshpass`（`apt install sshpass`），或者改用密钥登录。 |
| `ssh is not installed (or not on PATH)` | `PATH` 里找不到 ssh 客户端。 |
| `node "x": ssh to user@host timed out` | 端口/防火墙/`ConnectTimeout=10` 之内没握手成功；先用 `pp node ssh x` 手试。 |
| `pp ls` 整台机器显示 `unreachable` | ssh 层就不通（密钥、端口、`sshd`、`sshpass`）。`pp node test x` 会给一句人话。 |
| `pp up` 说已启动但状态 `off` | 远端没装 tmux（`pp node test` 会写 `tmux missing`），或 `tmux.socket` 名字在远端没有对应 server。 |
| `session "x": node "y" is not defined under "nodes"` | `sessions[].node` 写错或 `nodes:` 里删掉了它。`pp check` 会指出具体会话。 |
| `1 session still run on "far"` | `pp node rm` 的保护：有会话还在用它。先改 `node:` 或删掉会话，确实要删加 `--force`。 |
| 远端会话的 `cwd` 明明存在却说 `cwd does not exist` | 远端会话的路径是**远端**的路径，不是本机的。 |

## 命令名类

### 敲 `pp ls` 却打出 `Usage: pp [-t type] [-a] [-i input] ...`

那是 macOS（以及部分发行版）自带的 ASN.1 工具 `/usr/bin/pp`，不是我们。PATH 里谁靠前谁生效，而 `/usr/bin` 常常压过 npm 的全局 bin。

```bash
type -a pp                 # 看 PATH 上有几个 pp
pp doctor                  # 会直接写：ours: pp 0.3.0 (installed) / pp → /usr/bin/pp (not pi-plus)
pifarm ls                  # 安装时就带的备用名字（另一个是 pi-plus）
pp alias add pif           # 自己起名字：~/.local/bin/pif → 同一个脚本
pp alias ls                # 看已有别名 + 目录是否在 PATH
```

- 别名的默认目录是 `~/.local/bin`（可用 `--bin-dir` 或 `$PP_BIN_DIR` 改），它会提示该目录是否在 PATH 里
- `pp alias rm <name>` 只删指向本 CLI 的软链；指向别的东西会拒绝，交给你自己处理
- `install.sh` 也能一步换名：`PP_BIN_NAME=pifarm ./install.sh`，或 `PP_BIN_NAME="pp pif" ./install.sh`

### `error: ... is not a valid command name`

别名只接受 `[A-Za-z0-9._-]`，且不能以 `-` 开头（避免被当成 flag）。

## 升级类

### `pp update` 报 `notarget No matching version found`

npm 的 packument 缓存过期（刚发布时很常见）：

```bash
npm cache clean --force
pp update
```

### `pp update` 报 `cannot reach https://registry.npmjs.org/pi-farm/latest`

内网拿不到公共源。换源即可，包只在 npmjs 上有：

```bash
PP_NPM_REGISTRY=https://nexus.inner.example.com/repository/npm-group pp update
```

### `pp update` 提示 `cannot tell how this copy was installed`

脚本既不在 `node_modules/pi-farm/` 下，也不在 git 检出里（比如被手工拷过）。按提示手动升级：`npm i -g pi-farm@latest`，或重新 `git clone` + `./install.sh`。

## 启动类

### `session "backend" exited immediately`

```
error: session "backend" exited immediately
[backend] ...（pane 最后几行输出）
```

`pp up` 在创建会话 600ms 后会检查 pane 是否还活着，死了就把截到的输出打出来。常见原因依次排查：

```bash
pp up backend -v --dry-run      # ① 打印真实 argv，确认 agent/参数/目录
pp check backend                # ② cwd 是否存在、agent 是否在 PATH
```

- **agent 不在 PATH 上**：systemd/非交互 shell 的 PATH 很短。用绝对路径：`agent: /home/you/.nvm/versions/node/v26.13.1/bin/pi`
- **pi 参数不合法**：例如 `pi_session` 里有大写以外非法字符，或 `pi_session_dir` 指向不可写的目录。pi 会直接退出
- **cwd 不存在**：`cwd does not exist: /path`
- 想看到完整报错：临时加 `remain_on_exit: true`，然后 `pp logs backend -n 200`

### `cwd does not exist: /home/you/code/backend`

配置文件里的目录在这台机器上不存在（典型：`pp init` 生成的模板）。改 `cwd` 或先 `mkdir -p`。

### `directory does not exist: /tmp/x`（`pp new -C`）

`-C` 只接受已存在的目录，不会替你创建。

### `error: unknown session "9" (7 session(s) configured; see pp ls)`

序号从 1 开始，且只按**配置文件里的顺序**，不是 `pp ls` 筛过之后的顺序（筛过时请用名字）。

### `tmux session "api" already exists (--force to recreate, or pick another name)`

`pp new api` 撞名。`--force` 重建，或换个名字。

## tmux 类

### `tmux ... can't find pane: =backend`

0.2 之前的 bug：`send-keys` / `capture-pane` 的目标必须是 `=name:`（带冒号），而 `has-session` / `kill-session` 用 `=name`。升级即可。自查：

```bash
tmux list-panes -a -F '#{session_name}:#{pane_id}' | head
tmux send-keys -t '=backend:' 'echo ok' Enter      # 冒号不能少
```

### `no server running on /tmp/tmux-1000/pi-plus`

```bash
pp ls                    # 空表 = 确实没有会话
pp doctor                # tmux server 那行会写 not running (starts on demand)
```

用了 `--socket pi-plus` 时，你的 shell 里 `tmux ls` 看不到这些会话——需要 `tmux -L pi-plus ls`。

### 会话在 `tmux ls` 里有，但 `pp ls` 显示 `off`

两边看的不是同一个 socket。检查配置里的 `tmux.socket` 和你 `tmux ls` 用的 socket 是否一致；另外自启单元不会带命令行 `--socket`（只认配置文件里的 `tmux.socket`）。

### `STATE=dead`

pane 里的进程退出了，`remain-on-exit` 把 pane 留在那儿。看怎么回事：

```bash
pp logs backend -n 200
pp up backend            # 重建（restart: no 的会话必须点名）
```

## 名字 / remote-pi 类

### mesh 里看到的不是我配的名字

1. `cat <cwd>/.pi/remote-pi/config.json` 看 `agent_name`
2. 同一目录两个会话要求不同名字 → 必须 `remote_pi_mode: env`（文件只有一个 `agent_name`，`config` 模式最后一次写赢）
3. broker 侧同名冲突会临时显示 `name#2`，不会写回配置

```bash
pp check        # 共享 cwd + config 模式会给出警告
```

### 想彻底不进 mesh

```yaml
remote_pi_mode: off
# 或
remote_pi_name: false
```

`pp new` 加 `--no-remote-pi`。

### pi 里 `/session` 看到的名字不是我想的

那是 `pi_session_name`（`--name`），不是 tmux 名，也不是 remote-pi 名。看 [configuration.md](configuration.md#名字映射速查)。

## 自启类

### 重启后一个会话都没有，但 `systemctl --user is-enabled pi-plus` 说 enabled

三种可能，按概率：

1. **没开 linger**（服务器/无图形登录）：`sudo loginctl enable-linger "$USER"`
2. **WSL2**：发行版要有人调 `wsl.exe` 才会起来的，Windows 侧必须配触发（见 [autostart.md](autostart.md#wsl2只有里面装是不够的)）
3. **单元里没有 `KillMode=none`**：现象是 `Result=success` 但 tmux server 被 systemd 连坐杀掉了。老版本升级后请重装单元：`pp uninstall && pp install`

验证是不是第 3 种：

```bash
systemctl --user show pi-plus -p Result -p ExecMainStatus   # success
tmux ls                                                     # 空的 → 就是它
grep KillMode ~/.config/systemd/user/pi-plus.service         # 应该 =none
```

### 会话起来但立刻又被杀

`pp install` 之后又手动 `systemctl --user restart pi-plus.service`：oneshot 每次执行都会跑 `up --reconcile`，如果配置文件里某会话已 dead 且 `restart: always`，会被重建——这是预期行为，不是杀。

### 手动 `down` 的会话，巡检又起来了

只有 `always` 会。`unless-stopped` / `on-failure` 的手动停止记录在 `~/.local/state/pi-plus/state.json`：

```bash
cat ~/.local/state/pi-plus/state.json
pp up backend        # 点名启动会清掉这条记录，重新纳入巡检
```

## attach 类

### 从脚本 / agent 里 `pp attach` 输出乱码或卡住

`attach` 需要真正的终端（pty + termios）。非 TTY 直接拒绝，用 `script`、`expect`、管道都不行——你会得到 cooked mode，方向键变成 `ESC [ A` 之类的字面量。

- 本机：在真终端里跑 `pp attach backend`
- 远程：`ssh -t host 'pp attach backend'`（`-t` 必须有）
- 只想看输出：`pp logs backend -n 500` 或 `tail -f ~/.pi/plus/logs/backend.log`

## pi 扩展类

### pi 里没有 `/pp-ls`、`/pp-sw` 这些命令

扩展随 npm 包发布，但不会自动进 pi 的配置：

```bash
pi list                    # 看有没有 npm:pi-farm
pi install npm:pi-farm     # 装（写 ~/.pi/agent/settings.json）
```

装完在运行的会话里 `/reload`，或重开 pi。启动横幅的 `[Extensions]` 一节应出现 `pp-tmux.js`。

### `not running inside tmux (TMUX is unset)`

扩展靠 `$TMUX` 定位 tmux 服务器。pi 不在 tmux pane 里就会这样报。

```bash
tmux new -s work -c ~/code/api "pi"     # 在 tmux 里起
pp attach backend                        # 或者接到已有会话上
```

### `cannot switch: no tmux client is attached — attach first (pp attach <session>)`

会话是 `pp up` 在后台起的，没有终端 attach 在它上面，所以没有 client 可以切换/断开。
先 `pp attach <session>`，或在某个终端里 `tmux attach -t <session>`。

### `/pp-ls` 看不到某个会话

扩展只列**当前 `$TMUX` 指向的那个服务器**里的会话。`pp up --socket other` 起的会话在另一个
socket 上，`tmux -L other list-sessions` 才看得到。

## 定时类（`pp cron`）

| 现象 | 原因 / 处理 |
|---|---|
| 到点没动静 | `pp cron status` → crond 块在不在；`pp cron tick` 手工跑一遍看输出；`pp cron logs -n 40` |
| `crontab is not installed on this machine` | 装 cron（Debian/Ubuntu `sudo apt install cron`）；macOS 自带 |
| `pp cron install` 后 `crontab -l` 没有块 | 某些环境 `crontab` 要交互/权限；用 `crontab -l` 确认，或换成 `pp cron tick` 塞进你自己的调度器 |
| `cannot tell which session` / `which session?` | `cron add` 不在 tmux 里也没给 `--session`；补 `--session <name|#>` |
| `skipped: missed by 9h (catch-up 2h)` | 关机太久超了补跑窗口；重建作业时加 `--catch-up 24h` |
| `option --every needs a value` | 参数漏了值；`--every 5m`、`--in 90m`、`--cron "0 9 * * *"` |
| `"x" is not a duration` | 只认 `90`/`30s`/`5m`/`2h`/`1d` |
| 投递了但 pi 没把它当新消息 | 目标 pane 里不是 pi（是 shell 就变成了敲命令）；`pp logs <session>` 看现场 |
| 作业在别的机器/配置上 | 作业记了 `socket` 与 `configPath`；换配置后重建，或 `pp cron ls` 看来源 |
| `cron.json.lock` 残留 | 超过 10 分钟自动视为陈旧；急用可手动删除 |

## 控制面板类（`pp tui`）

| 现象 | 原因 / 处理 |
|---|---|
| `pp tui needs a terminal` | 退出码 2：`stdout` 不是 tty（管道、`$( )`、CI）。要一帧快照用 `pp tui --once` |
| 画面像乱码 / 一直滚动 | 终端不是 UTF-8 或 `TERM` 太原始：`export TERM=xterm-256color`、`export LANG=C.UTF-8` |
| 中文字符把边框挤歪 | 宽度按 `displayWidth` 算（CJK 记 2 列）；若某个 emoji 仍错位，多半是宽度表没覆盖到，把该字符和 `pp -V` 一起报上来 |
| 预览是空的 | 该会话还没输出，或 pane 已 dead（`remain-on-exit` 下会保留最后一屏）；`pp logs <name>` 对照 |
| `Enter` 后没反应，只有底部一行提示 | 0.11.4 起失败原因会留在 footer 约 5 秒：`X is not running` / `no attached tmux client to switch` / `could not switch to X: <tmux 原话>` |
| 选中待办回车后「进去又推出」，之后按键全无反应 | 0.11.4 修的两个 bug：待办行没带会话名（`attach(undefined)`，只闪一行提示），以及把"交出终端给 tmux"误判成退出 —— 后者会 `pause()` stdin，面板还活着但键盘死了，只能 Ctrl+C。升级：`npm i -g pi-farm@0.11.4` |
| 面板开在 tmux 外面（ssh 里直接 `pp tui`）时 `/pp-back` 说 `no panel remembered` | 0.11.5 起会记住"面板在 tmux 之外"，此时 `/pp-back` 与 `pp back` 改成 **detach**（把你送回画着面板的那个终端）。手工应急就按 `Ctrl-b d` |
| 进入某个会话后不知道怎么写回面板 | `pp back`（会话内用 `/pp-back`）。面板在切换的瞬间还会在目标会话的状态行打一句 `panel is behind you — pp back …` |
| `Enter` 后回到面板但内容没变 | 那就在同一个 client 上 `switch-client` 了（tmux 内）；按 `r` 重绘，或 `Ctrl-b d` 再回来 |
| 列表里多出「not in config」的会话 | tmux 里手工起的；`pp up <name>` 想接管就先写进配置 |

## 待办类（`pp todo`）

| 现象 | 原因 / 处理 |
|---|---|
| 清单一直是空的 | 扩展是不是新版：`pp -V` ≥ 0.8.0，且 `pi install npm:pi-farm` 之后重开 pi；`PP_TODO_SETTLED=off` 时只有阻塞提示和手工登记会入列 |
| 每个会话跑完都刷一条 | `PP_TODO_SETTLED` 默认只记「结尾是问句」的；你可能是 `always`，改回 `question` 或 `off` |
| 待办一直不消失 | 只有会话**重新开跑**才会自动完成；你只是 `Esc` 关掉提示不算 |
| 显示 `(offline)` | 该会话当前没在跑（按 `pp` 用的 socket 判断）；待办本身仍然有效 |
| `no todo #9` | `#` 按创建时间倒序（含已完成的行）编号，先 `pp todo ls --all` 看实际条目数 |
| 在 A 机器记的待办，B 机器看不到 | 待办是本机的（`$XDG_STATE_HOME/pi-plus/todos.json`），不跨机器同步 |
| 想彻底不来待办 | `PP_TODO_SETTLED=off` 并且别调 `todo` 工具；阻塞提示仍会登记（那是真实阻塞） |

## 发布 / 安装类

### `npm i -g pi-farm` 装到的是别的东西或 404

内网镜像 `npm config get registry` 指向 Nexus 时拿不到公网包：

```bash
npm i -g pi-farm --registry https://registry.npmjs.org/
```

### `pp: command not found`

```bash
npm bin -g 2>/dev/null || echo "$(npm root -g)/../bin"
echo "$PATH" | tr ':' '\n' | grep -i node
```

nvm 的全局 bin 通常在 `~/.nvm/versions/node/vX/bin`，装完要重开 shell 或 `hash -r`。

### `pp -V` 的版本和 GitHub 上不一致

```bash
which -a pp            # 可能还有旧的 ~/.local/bin/pp 符号链接
npm ls -g --depth=0 | grep pi-farm
```

## 审计类（`pp audit`）

| 现象 | 原因与处理 |
| --- | --- |
| `pp audit` 说 `nothing recorded` | 只记录"改动"：`up`/`down`/`restart`/`rm`/`send`/`cron add|rm`/`node add|rm`。`--dry-run`、`status`、`ls`、`check` 都不会写。文件默认 `$XDG_STATE_HOME/pi-plus/audit.log`，可用 `--file` 指定别的。 |
| 想看是谁在凌晨停的 | `pp audit --action down --since 12h`；每条的 `actor` 是 `user@host#pid`，cron 触发的是同一个用户但 pid 不同。 |
| 文件涨得太大 | 超过 2 MB 自动轮转到 `audit.log.1`；主动裁剪用 `pp audit --prune 90d`。 |
| 想知道那条命令为什么失败 | 失败时命令自己会非零退出并报错，审计只记"做了什么"，不记 stderr —— 失败细节看终端输出或 `pp logs`。 |

## 配置类

### `unknown key "pi_sesion" (ignored)` 之类的警告

拼写错误被忽略而不是报错（故意这么设计，免得升级时新增字段导致旧配置无法解析）。`pp check` 会列出所有警告。

### `config file not found`

```bash
pp check                           # 会打印实际搜索过的路径
PI_PLUS_CONFIG=/path/to/plus.yml pp ls
pp init                            # 写一份模板到 ~/.pi/plus.yml
```

### 想确认某个字段到底被解析成了什么

```bash
pp check --json | jq '.sessions[]? // .'      # 或
pp up backend --dry-run -v                    # 打印最终 argv + env
```

`--dry-run` 会显示形如：

```
[backend] cwd=/home/you/code/backend tmux=backend pi-session=backend remote-pi=backend(mode=config)
[dry-run] tmux new-session -d -s backend -c /home/you/code/backend -- env ... pi --name backend
```

## 还是不行

```bash
pp doctor --json | jq
pp check --json | jq
pp up <name> -v --dry-run
```

把这四条的输出贴到 issue（记得先脱敏路径）。
