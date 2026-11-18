# 排障手册

按「你看到的原文」查。每条都附上验证命令。

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
