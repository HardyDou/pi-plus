# 配置参考

一份 YAML 描述「要跑哪些 agent、在哪里跑、叫什么名字、崩了怎么办」。默认位置 `~/.pi/plus.yml`，`pp check` 会把解析结果和警告全打出来。

## 配置文件在哪

按优先级找：

| 顺序 | 位置 |
|---|---|
| 1 | `-c` / `--config <path>` |
| 2 | 环境变量 `$PI_PLUS_CONFIG`（支持 `~` 和 `$VAR`） |
| 3 | 当前目录 `pi-plus.yml` / `pi-plus.yaml` / `plus.yml` / `plus.yaml` |
| 4 | `~/.pi/plus.yml` / `~/.pi/plus.yaml` |
| 5 | `$XDG_CONFIG_HOME/pi-plus/config.yml`（默认 `~/.config/pi-plus/config.yml`） |

`pp init` 写 `~/.pi/plus.yml`（`--local` 写 `./pi-plus.yml`，`--path <p>` 指定路径）。配置文件不存在时，除了 `init` / `new` 之外的命令都会以退出码 2 报 `config file not found`。

## 结构

```yaml
version: 1                 # 可选，目前不参与逻辑

tmux:                      # 可选
  socket: pi-plus          # 等价于每条命令都加 --socket pi-plus

defaults:                  # 可选：所有 session 的默认值（键同 session，name/cwd 除外）
  agent: pi
  restart: always
  env:
    TZ: Asia/Shanghai

nodes:                     # 可选：别的机器，session 可以用 node: 指过去
  - name: prod-01
    host: 10.0.0.11
    user: deploy
    identity: ~/.ssh/id_ed25519

sessions:                  # 必填，非空列表
  - name: backend
    cwd: ~/code/backend
  - name: prod-api
    node: prod-01          # 这个会话在 prod-01 上跑
    cwd: /srv/api
```

`nodes:` 的字段（`name`/`host` 必填，`port`/`user`/`identity`/`password`/`password_env`/`note` 可选）
和远端会话怎么跑，见 [nodes.md](nodes.md)。

## session 字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | string | **必填** | 会话名，也是另外两个名字的默认值。只能用字母、数字、`-`、`_`；`tmux_name` 全局唯一 |
| `cwd` | string | 当前目录 | 工作目录。支持 `~` 和 `$VAR`，必须是存在的目录（`pp check` 会验证） |
| `agent` | string 或列表 | `pi` | 启动命令。字符串按 shell 规则切分（支持引号），列表原样使用。`basename` 是 `pi` 时会自动加 pi 的参数 |
| `pi` | bool | 按 `agent` 推断 | 强制/禁止加 pi 参数（`--name` / `--session-id` 等） |
| `pi_session` | string | 无 | 续接哪段对话：`.jsonl` 路径（`/`、`~/`、`./`、`../`、`*.jsonl`）走 `--session`，否则当 session id 走 `--session-id`。id 规则：首字符是字母或数字，末字符也是字母或数字，中间允许字母、数字、`.`、`_`、`-` |
| `pi_session_name` | string / null | `name` | pi 的显示名（`--name`）。`null` 表示不加 |
| `pi_session_dir` | string | 无 | `--session-dir`，pi 存会话文件的目录 |
| `remote_pi_name` | string / false | `name` | remote-pi mesh 里的 agent 名。`false` 表示不设置。会被规整：`/ : @ # 空白` → `-`，禁止 `broadcast` / `broker` |
| `remote_pi_mode` | `config` / `env` / `off` | `config` | 见下文「remote-pi 名称的三种模式」 |
| `remote_pi` | map | 无 | 上面两个字段的嵌套写法：`remote_pi: {name: x, mode: env}` |
| `env` | map | `{}` | 追加的环境变量（值为 null 的键忽略）。与 `defaults.env` **合并**，同名覆盖 |
| `args` | string 或列表 | `[]` | 追加到 agent 命令末尾的参数（整体替换 `defaults.args`，不合并） |
| `log` | string / true | 无 | 用 `pipe-pane` 把输出落到文件；`true` 表示 `<cwd>/.pi-plus.log`。目录会自动创建 |
| `remain_on_exit` | bool | `false` | tmux 的 `remain-on-exit`（退出后保留 pane 以便看日志）。`restart: no` 自动开启 |
| `restart` | `no`/`always`/`on-failure`/`unless-stopped` | `always` | 拉起策略，见下节 |
| `node` | string | 无 | 在哪个 `nodes:` 节点上跑（不写就是本机）。所有 tmux 操作变成 `ssh <node> tmux …`，远端不需要装 pp |

未知键不会让命令失败，但会作为警告出现（`unknown key "xxx" (ignored)`），方便发现拼写错误。

## `restart` 策略

语义对齐 docker compose：

| 策略 | 裸 `pp up` | 自启 / `--watch`（`--reconcile`） | `pp up <name>` | 崩溃后 |
|---|---|---|---|---|
| `no` | 跳过 | 跳过 | 重建 | 保留 dead pane（可 `pp logs`），只有点名才重建 |
| `always` | 启动 | 启动 | 重建 | 下次 `up`/巡检复活 |
| `on-failure` | 启动 | 手动 `down` 过的跳过 | 重建 | 下次 `up`/巡检复活 |
| `unless-stopped` | 启动 | 手动 `down` 过的跳过 | 重建 | 下次 `up`/巡检复活 |

- 「手动 `down`」记录在 `$XDG_STATE_HOME/pi-plus/state.json`（默认 `~/.local/state/pi-plus/state.json`），以配置文件路径为 key
- `pp up <name>`（点名启动）会清掉这条记录，把这个会话重新纳入巡检
- `restart: true` / `false` 是 `always` / `no` 的别名

## remote-pi 名称的三种模式

remote-pi 的身份是 `<cwd>@<名字>`，名字存在**每个目录**的 `<cwd>/.pi/remote-pi/config.json`（`agent_name` 字段），`/remote-pi rename` 改的就是它。

| 模式 | 行为 | 适用 |
|---|---|---|
| `config`（默认） | `pp` 启动前把 `agent_name` 写进该文件，保留其它键 | 一个目录一个会话，希望名字持久 |
| `env` | 不写文件，注入 `REMOTE_PI_DIRECT_CONFIG=<JSON>`（remote-pi 优先级高于文件） | 同一目录多个会话、临时会话（`pp new` 默认） |
| `off` | 什么都不做 | 不想进 mesh |

`config` 模式下，同一 `cwd` 的两个会话如果要求不同名字，`pp check` 会警告「last write wins」并建议改 `env`——因为文件只有一个 `agent_name`。

## 完整示例

```yaml
version: 1

tmux:
  socket: pi-plus

defaults:
  agent: pi
  restart: always
  env:
    TZ: Asia/Shanghai

sessions:
  # ① 最简：只想后台跑一个 pi，名字/目录都用默认规则
  - name: backend
    cwd: ~/code/backend

  # ② 续接一段已有的 pi 对话，并把显示名固定下来
  - name: risk
    cwd: ~/code/risk
    pi_session: 3f9a1c2e           # 走 --session-id
    pi_session_name: risk-01

  # ③ 同一目录两个 agent，各自独立的 mesh 名字
  - name: bh-01
    cwd: ~/code/baohan
    remote_pi_name: bh-system-01
    remote_pi_mode: env
  - name: bh-02
    cwd: ~/code/baohan
    remote_pi_name: bh-system-02
    remote_pi_mode: env

  # ④ 不是 pi 的 agent，带一个常驻日志
  - name: shell
    cwd: /srv/tools
    agent: bash
    restart: no
    log: ~/.pi/plus/logs/shell.log

  # ⑤ 带参数的 pi，按需扩写
  - name: reviewer
    cwd: ~/code/review
    agent: pi --model opencode-go/deepseek-v4.1-flash
    args: [--approve]
```

## 名字映射速查

```
name: backend
├─ tmux session      tmux_name        = backend      （pp attach backend / tmux attach -t backend）
├─ pi 显示名         pi_session_name  = backend      （pi 里 /session 看到的名字）
└─ remote-pi agent   remote_pi_name   = backend      （<cwd>@backend）
```

三者都能单独覆盖；pi 的 **session id** 不是名字，是 `pi_session`。

## 校验规则汇总

`pp check` 会报出（并且 `pp up` 会拒绝启动）的情况：

- `name` 为空、含 `.`/`:`/空格等非 tmux 安全字符
- `tmux_name` 重复
- `cwd` 不存在或不是目录
- `pi_session` 不符合 session id 规则（且不是路径）
- `remote_pi_mode` 不是 `config`/`env`/`off`
- `restart` 不是四个策略之一
- `env` 不是映射、`args` 不是字符串/列表
- `sessions` 不是列表、根节点不是映射

仅作为「提示」（不影响退出码语义，但会打印）：`restart: no` 不参与裸 `up`、被手动 `down` 过、`config` 模式下共享目录写同一个名字、agent 不在 PATH 上。
