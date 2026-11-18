# 架构与实现

本文讲 `pp`（npm 包 `pi-farm`）内部怎么跑起来：模块划分、一份 YAML 到「一个跑着 pi 的 tmux session」的完整链路、状态文件、restart 策略的状态机，以及几个不显然的实现决定。

## 设计目标

1. **一个名字贯穿三处**：tmux session 名、pi session 显示名（`--name`）、remote-pi mesh 里的 agent 名，默认都取 YAML 里的 `name`。
2. **声明式**：`pp up` 幂等；`pp ls` 一眼看清配置与现实的差距；重启后由 systemd/launchd 再跑一次同一份配置。
3. **零运行时依赖**：只用 Node 内置模块，`npm i -g pi-farm` 就是一次性安装，不需要编译、不需要 postinstall。
4. **不碰用户进程**：所有 agent 都跑在 tmux 里，`pp` 自己不常驻、不做守护进程（除了 systemd 的 oneshot 跑一次）。

## 模块

```
bin/pp.js          参数解析、命令分发、顶层错误 → 退出码
src/config.js      YAML -> 规范化的 session 对象；路径发现；argv 构造；序号解析
src/yaml.js        零依赖 YAML 子集解析器（parseYaml / YamlError）
src/tmux.js        tmux CLI 的薄封装（Tmux 类）+ paneTarget + resolveExecutable
src/remote-pi.js   读写 <cwd>/.pi/remote-pi/config.json，构造 REMOTE_PI_DIRECT_CONFIG
src/state.js       手动停止记录（XDG state），给 restart 策略用
src/mesh.js        remote-pi broker 的零依赖客户端（探测 / 注册 / 发送 / ACK）
src/autostart.js   systemd / launchd 单元渲染与安装/卸载/状态查询
src/commands.js    各子命令实现（up/down/restart/status/attach/logs/send/mesh/check/doctor/init/install/new/alias）
src/help.js        COMMANDS 单一数据源 + 总览/单命令页/拼写建议
src/aliases.js     备用命令名（pifarm/pi-plus/自定义软链）+ PATH 上 pp 归属判定
src/example.js     `pp init` 写入的示例配置
```

`src/help.js` 的 `COMMANDS` 是命令表的唯一来源：总览、单命令帮助、别名解析和拼写建议都由它生成，测试会断言「每个规范命令都有完整帮助页」，所以加命令时不会出现文档漂移。

## mesh 客户端（`pp mesh`）

`src/mesh.js` 直接说 broker 的换行分隔 JSON 协议（UNIX socket），不依赖 remote-pi 的代码，也不启动 pi：

```
pp mesh ls       → {"type":"list_peers"}             → body.peers 里的地址数组（只读，不注册）
pp mesh send     → {"type":"register",name,cwd}      → register_ack.address_assigned
                 → {from,to,id,re:null,body}         → {re:<id>, body:{type:"ack",status:"received|busy|denied"}}
                 ← 对方回信 {re:<id>, from, body}     ← --reply 期间打印并提前返回
```

几个要点：

- **为什么 `ls` 要"只读探测"**：broker 收到注册就会广播 `peer_joined`，别人的 UI 会闪一条通知；纯查询用 `list_peers` 不会改变任何人的 peer 列表。
- **会话名 → 地址**：`sessionMeshAddress()` 按 `<cwd>@<remote_pi_name>` 拼，`remote_pi_mode: off` 或没有名字时返回 `null`；broker 对同 `(cwd,name)` 的第二次注册会加 `#2` 后缀，`livePeersFor()` 把 `base` 和 `base#N` 都算作同一会话。
- **ACK 语义**：单播等 ACK，`busy` 意味着对方正在跑一轮、消息被丢弃（不是排队），所以 `pp` 直接报错让你重试；组播/广播没有逐条 ACK。
- **临时身份**：注册名默认 `pp-mesh`，`--as` 可改；进程退出即注销，别人看到的只是一条上下线。
- **回复**：`--reply <ms>` 在同一连接上继续等 `re === 本次 id` 的信封；单播拿到第一条就提前返回，组播/广播会一直收到窗口结束。
- **跨机**：地址前缀 `<pc>:` 由 broker leader 的 relay 桥完成，发送端无需配对；`pp mesh ls` 会显示 `PC` 列。

## 启动链路（`pp up`）

```
findConfigPath()            -c / $PI_PLUS_CONFIG / ./*.yml / ~/.pi/plus.yml / $XDG_CONFIG_HOME/pi-plus
  ↓ loadConfigFile()
parseYaml() → normalizeConfig()
  ↓ 每条 session 变成
{ name, tmuxName, cwd, agent[], pi, piSession, piSessionDir, piSessionName,
  remotePiName, remotePiMode, env{}, args[], log, remainOnExit, restart }
  ↓ selectSessions()       按名字/序号挑；裸 up 跳过 restart:no 与会话被手动停止的（--reconcile 时）
  ↓ prepareSession()       mkdir 日志目录；remote_pi_mode: config 时写 <cwd>/.pi/remote-pi/config.json
  ↓ launchSpec()           remote_pi_mode: env 时注入 REMOTE_PI_DIRECT_CONFIG=<合并后的 JSON>
  ↓ tmux.create()          tmux new-session -d -s <tmuxName> -c <cwd> -- env K=V ... <argv>
  ↓ pipe-pane / remain-on-exit   （配置了 log 才挂日志；restart:no 自动 -w remain-on-exit）
  ↓ verifyStartup()        等 600ms，检查 session 是否还在、pane 是否 dead，失败时回放 pane 内容
  ↓ clearStopped()         清掉「手动停止」记录
```

`buildSessionArgv()` 决定 pi 的参数顺序，这是唯一给 pi 加参数的地方：

```
<agent...>  [--name <pi_session_name>]  [--session-dir <dir>]
            [--session <path> | --session-id <id>]  <args...>
```

只有 `pi`（即 `basename(agent[0]) === "pi"`，或显式 `pi: true`）才会加这些参数；`agent: bash` 之类的会话原样执行。

## 名字解析（三处名字 + 序号）

| 目标 | 字段 | 默认 |
|---|---|---|
| tmux session | `tmux_name` | `name` |
| pi session 显示名 | `pi_session_name` | `name`（`null` 表示不加 `--name`） |
| remote-pi agent | `remote_pi_name` | `name`（`false` 表示不设置） |

pi 的 **session id**（`pi_session`）是另一回事：它是「续接哪段对话」，和显示名无关。给 id 用 `--session-id`，给 `.jsonl` 路径用 `--session`，由 `isSessionPath()` 判断。

CLI 里凡是收 `<name>` 的地方都支持序号：`resolveSessionRef()` 先按 `name`/`tmuxName` 精确匹配，再按配置顺序把纯数字当成 1-based 下标（就是 `pp ls` 第一列的 `#`）。名字优先于序号，所以真有会话叫 `3` 时不会被序号抢走。

## restart 策略的状态机

`restart` 决定「谁在什么情况下把会话拉起来」，语义对齐 docker compose：

| 策略 | 裸 `up` | `up --reconcile`（自启/watch） | `up <name>`（手动点名） | pane 崩溃后 |
|---|---|---|---|---|
| `no` | 不参与 | 不参与 | 重建 | 保留 dead pane（自动 `remain-on-exit`），`pp logs` 仍可看 |
| `always` | 启动 | 启动 | 重建 | 下次 `up`/巡检重启 |
| `on-failure` | 启动 | 手动 `down` 过的跳过 | 重建 | 下次 `up`/巡检重启 |
| `unless-stopped` | 启动 | 手动 `down` 过的跳过 | 重建 | 下次 `up`/巡检重启 |

「手动 `down` 过」这件事记在状态文件里（见下节），`clearStopped()` 会在成功启动后清除；这正是 compose 里 `unless-stopped` 与 `always` 的区别。

判断一个会话「要不要重建」靠一次 `tmux list-panes -a` 快照：session 不存在 → 创建；存在但所有 pane 都 dead → 重建；存在且活着 → 跳过（`--force` 例外）。

## 状态文件

```
$XDG_STATE_HOME/pi-plus/state.json      （默认 ~/.local/state/pi-plus/state.json）
```

结构是以**配置文件的绝对路径**为 key 的桶：

```json
{
  "/home/user/.pi/plus.yml": {
    "backend": { "stopped": true, "at": "2026-11-18T09:12:03.114Z", "reason": "down" }
  }
}
```

- 用配置路径做 key，所以同一个会话放在两份配置里互不影响
- 读取对损坏的 JSON 容错（返回 `{}`），不会因为半个字节把 `pp ls` 弄挂
- 只在 `down` 且策略为 `unless-stopped`/`on-failure` 时写

## tmux 交互细节

- **pane 目标必须带冒号**：`send-keys`/`capture-pane`/`pipe-pane`/`set-option -w` 用 `=name:`（`paneTarget()`），而 `has-session`/`kill-session` 用 `=name`。混用会得到 `can't find pane: =xxx`。
- **幂等检查用只读模式**：`Tmux.run(..., { readOnly: true })` 在 `--dry-run` 下依然真实执行，否则 dry-run 时 `sessionExists()` 会因为「命令没跑」而谎报会话不存在。
- **日志**：`log:` 用 `pipe-pane -o -t =name: "cat >> '<path>'"`，`prepareSession()` 提前 `mkdir -p` 日志目录，否则首次开机写入会静默失败。
- **socket 隔离**：`tmux.socket` / `--socket X` 等价于 `tmux -L X`，端到端测试靠它完全隔离，不碰默认 socket 上的生产会话。

## systemd / cgroup 的坑（`KillMode=none`）

单元是 `Type=oneshot`，`ExecStart=... pp up --config <cfg> --reconcile`。默认 `KillMode=control-group` 意味着**单元结束时 systemd 会把它 cgroup 里的所有进程杀干净**——而 tmux server 正是这个单元的孙进程。结果就是：日志显示 `Result=success`，会话却一个都不剩。

所以渲染出的单元里固定带 `KillMode=none`，让 tmux 与 agent 逃出这次清理。用真实单元的副本做过冷启动验证：加 `KillMode=none` 前「成功但零会话」，加之后会话存在、单元退出后仍在、崩溃后 `--reconcile` 能复活。

`--reconcile` 就是给这种「非用户交互」场景用的：跳过被手动 `down` 掉的 `unless-stopped`/`on-failure`，其余按策略启动/重建。

## remote-pi 名称的两种注入方式

remote-pi 的 agent 身份是 `<cwd>@<name>`，name 存在**每个目录**下的 `.pi/remote-pi/config.json`（字段 `agent_name`），`/remote-pi rename` 改的也是这个文件。

- `remote_pi_mode: config`（默认）：`pp` 在启动前把 `agent_name` 写进那个文件，和 `/remote-pi rename` 的效果一致，重启后仍在。**同一目录只能有一个名字**，所以两个会话共用 cwd 且名字不同时 `normalizeConfig()` 会警告，并建议改用 env。
- `remote_pi_mode: env`：不写文件，用 `REMOTE_PI_DIRECT_CONFIG`（内联 JSON，remote-pi 优先读它）把「文件里的其它选项 + 我们的 agent_name」传给 pi。适合共享目录、临时会话（`pp new` 默认用它）。
- `remote_pi_mode: off` / `remote_pi_name: false`：完全不设置。

## 测试与可观测性

- `--dry-run` 打印真正会执行的命令（`tmux new-session ...`、`tmux send-keys ...`），CI 与人工排查都用它。
- `--json` 给机器读：`up` → `{started,skipped,failures}`，`ls` → 行数组，`check` → `{ok,problems,notes,config}`，`doctor` → `{checks,warnings}`。
- 单元测试覆盖 YAML 解析、配置归一化、restart 策略、状态文件、单元渲染、帮助页与 `pp new`；端到端脚本 `test/e2e.sh` 用独立 socket 跑 86 项真实交互。
