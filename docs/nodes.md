# 别的机器上的会话（`nodes`）

一台机器一个 `node`。登记一次，之后那台机器上的 tmux 会话就跟本机的会话一样：
`up` / `down` / `attach` / `logs` / `send` / `restart` / `todo` / `tui` / `cron` 全都能用，
唯一的区别是每条 tmux 命令都套了一层 `ssh`。

远端**不需要安装 pp**，只需要 sshd、tmux，以及（跑 agent 会话时才需要）`pi`。

## 一分钟上手

```bash
# 1. 登记一台机器（四选一认证方式，见下）
pp node add prod-01 --host 10.0.0.11 --user deploy --identity ~/.ssh/id_ed25519

# 2. 让它自证一下：一次 ssh 往返，报告 os/tmux/pi/pp/负载/会话数
pp node test prod-01

# 3. 在配置里把会话指过去
pp node show prod-01        # 看哪几个会话用到了它
pp ls                       # NODE 列会显示 prod-01
```

`pp node test` 的输出长这样：

```
ok   prod-01      deploy@10.0.0.11:22  184ms
     host   prod-01  os Linux 6.8.0-45-generic
     tmux   tmux 3.4   node v22.11.0   pi /usr/local/bin/pi   pp /usr/local/bin/pp
     sessions 6   load 0.42 0.51 0.60   up 12d
```

少什么它会直接说（`prod-01 has no tmux — sessions cannot run there until it is installed`），
而不是等你 `pp up` 失败了再猜。

## 认证：从最安全的开始挑

| 方式 | 怎么写 | 说明 |
| --- | --- | --- |
| **密钥文件** | `--identity ~/.ssh/id_ed25519` | 推荐。配置文件里没有秘密 |
| **ssh agent / 默认密钥** | 什么都不给 | 走 ssh 自己的默认逻辑（agent、`~/.ssh/config`） |
| **复用 ssh config** | `--from-ssh-config prod-01` | 把 `~/.ssh/config` 里某个 `Host` 的 `HostName`/`Port`/`User`/`IdentityFile` 抄过来 |
| **环境变量里的密码** | `--password-env PP_PROD_PASS` | 密码不落盘；变量没设置时 `pp` 会直接报错，而不是偷偷退回密钥 |
| **密码写进配置** | `--password '<密码>'` | 最差的选择。写入后文件被 `chmod 600` 并给出警告 |

密码一律通过 `sshpass -e`（即环境变量 `SSHPASS`）交给 `ssh`，**不会出现在命令行上**，
所以 `ps` 看不到它。用到密码时远端机器需要装 `sshpass`（`apt install sshpass`）；
没装时 `pp` 会明说，而不是打一个看不懂的 ssh 失败。

交互式添加（不带 `--host` 且是终端）会依次问：ip/dns、端口、用户名、
认证方式（密钥路径 / `password` / `$VAR`）。

## 配置长什么样

节点和会话在**同一个文件**里（默认 `~/.pi/plus.yml`），`nodes:` 在前，`sessions:` 在后：

```yaml
version: 1

nodes:
  - name: prod-01
    host: 10.0.0.11
    port: 2222                 # 默认 22
    user: deploy
    identity: ~/.ssh/id_ed25519
    note: 生产集群的跳板           # 只给人看
  - name: textbook
    host: textbook.example.com
    user: ubuntu
    password_env: TEXTBOOK_PASS

sessions:
  - name: prod-api
    node: prod-01               # ← 这个会话在 prod-01 上
    cwd: /srv/api
  - name: textbook-web
    node: textbook
    cwd: /srv/web
  - name: local-notes
    cwd: ~/notes                # 没有 node 就是本机
```

`host:` 也接受你随手粘的形式：`deploy@10.0.0.11:2222`、`ssh://deploy@10.0.0.11:2222`。
显式写的 `user:` / `port:` 优先于 `host` 里带的信息。

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✓ | 节点名，字母数字开头，可含 `.` `_` `-` |
| `host` | ✓ | ip / dns（可带 `user@`、`:port`） |
| `port` | | ssh 端口，默认 22 |
| `user` | | 登录用户，默认用 ssh 自己的（本地用户名 / ssh config） |
| `identity` | | 私钥路径，`~` 和 `$VAR` 会展开 |
| `password` | | 明文密码（不推荐，文件会被 chmod 600） |
| `password_env` | | 从这个环境变量读密码 |
| `note` | | 自由文本，`pp node ls` 里显示 |

`password` 与 `password_env` 只能给一个；两个都写会报错。同时给 `identity` 和
`password` 只给警告（ssh 会先用密钥）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pp node ls` | 表格：名字、`user@host:port`、认证方式、上面有几个会话、备注 |
| `pp node show <name>` | 详情：完整字段（密码打码）+ 用到它的会话列表 |
| `pp node add <name> …` | 新增；同名视为编辑，会报告改了哪些字段 |
| `pp node rm <name>` | 删除；还有会话指向它时**拒绝**，`--force` 才硬删（会留下悬空引用） |
| `pp node test <name>` | 一次 ssh 往返，报告机器体检结果（`--all` 测全部） |
| `pp node exec <name>… -- <cmd>` | 在机器上跑一条命令，不占会话；`--all`/`--tag` 选机群，`--timeout <秒>` 限时，`--json` 机读 |
| `pp node ssh <name>` | 照着登记的参数开一个交互式 ssh 会话 |

`pp node add --dry-run` 只打印将要写入的 YAML 块，不动文件。

### 用 tag 把机群分组

```yaml
nodes:
  - name: p201
    host: 192.168.5.201
    user: infra-nginx
    identity: ~/.ssh/id_ed25519_ops
    tags: [prod, baohan]
  - name: b111
    host: 192.168.5.111
    user: dev-mysql
    tags: [dev, mysql]
```

```bash
pp node add p201 --from-ssh-config p201 --tag prod        # 加标签（可重复，累加不覆盖）
pp node ls --tag prod                                     # 只看这类机器
pp node exec --tag prod -- 'systemctl is-active nginx'    # 只在这类机器上跑
pp up --tag prod                                          # 只拉起这类机器上的会话
pp restart --tag mysql                                    # 只重启这类机器上的会话
```

多个 `--tag` 是**都要满足**（`--tag prod --tag db` = 既 prod 又 db）。`--tag` 与 `--node` 可以叠加，
等价于"这台机器且带这些标签"。

### 生产机器加一把锁：`guarded: true`

```yaml
nodes:
  - name: p201
    host: 192.168.5.201
    user: infra-nginx
    tags: [prod, baohan]
    guarded: true
```

```bash
pp node add p201 --from-ssh-config p201 --guard      # 加锁
pp node add p201 --from-ssh-config p201 --no-guard   # 解锁（其它字段原样保留）
pp down p201-web            # 跳过并提示；会话不动
pp down p201-web --force    # 真的停
pp rm p201-web              # 确认时会把"guarded machine"写进问句
```

`pp node ls` 里被锁的机器名字前面带 `!`，表格下方有图例；`pp node show` 会单独一行写清楚。
锁只影响"停"和"删"两类操作，`up`/`restart`/`send`/`attach`/`logs` 不受影响 —— 它是给深夜手滑用的，不是给你添堵的。

### 用 `pp node exec` 做巡检（不开会话）

```bash
pp node exec db-01 -- df -h / | tail -1          # 一台
pp node exec --all -- uptime                     # 所有机器，逐台打印
pp node exec --all -- 'systemctl is-active nginx || true'
pp node exec --all --json -- 'cat /proc/loadavg' # 机读，接监控
pp node exec --all --quiet -- 'test -f /etc/cron.d/backup'   # 只关心失败的
```

`--` 之后的整串作为**一条**远端命令行交给远端 shell，管道、通配符、引号都按你在那边敲的行为执行。

默认逐台跑（输出顺序稳定、不会同时把机群压出负载毛刺）；`--parallel` 同时跑全部选中机器：

```bash
pp node exec --all --parallel -- 'df -h / | tail -1'
```

六台机器、每条命令耗时 1 秒时：逐台 7.9s → `--parallel` 1.2s。输出仍按节点名字顺序打印，不会互相插队。
任一台非零退出，`pp` 自身返回 1（`--json` 时每台一条记录）。`--timeout` 默认 60 秒，超时按失败计。

`pp node test --json` 的字段是稳定的，可以直接当监控契约：

```json
{ "node": "prod-01", "ok": true, "ms": 412, "host": "prod-01.example", "os": "Linux 6.8.0",
  "arch": "x86_64", "tmux": "tmux 3.4", "pi": "0.13.1", "pp": "-", "sessions": "3",
  "load": "0.42 0.51 0.60", "up": "1182" }
```

（`node` 是远端的 node 版本；读不到的键是 `"-"`，`up` 单位是秒。）

### 在面板里进入远端会话

`pp tui` 的会话列表会给远端会话标上 `@<node>`，右下预览也是按会话所在机器抓的（一条 ssh 往返）。
在那行上按 Enter：本地面板把自己的终端交给 `ssh -t <node> tmux attach`，你在远端会话里 detach（或 `/pp-quit`）
就回到面板 —— 不能像本机那样 `switch-client`，因为 client 在本地、会话在远端。

### 在远端机器上新开会话

```bash
pp new api --node t114 -C /srv/api --agent pi --save
```

`-C` 这时是**那台机器上**的路径（本地不再校验目录是否存在，交给远端 tmux），
`--save` 会写成：

```yaml
sessions:
  - name: api
    cwd: /srv/api
    node: t114
    remote_pi_name: api
    remote_pi_mode: env
```

### 只对一台机器批量操作

```bash
pp up --node t114            # 只把这台机器上的会话拉起来
pp down --node t114          # 只停这台机器上的
pp restart --node t114       # 只重启这台机器上的
pp ls --node t114            # 只看这台机器上的会话
```

不带名字时 `--node` 只影响"批量"命令（`up`/`down`/`restart`/`ls`/`send`），单会话命令本来就已经定位到具体机器了。

## 远端会话是怎么跑起来的

- 所有 tmux 调用都变成 `ssh <node> tmux -L <socket> …`；`${TMUX}`、`-L socket`、
  `-t =name:` 这些细节和本机完全一致，所以 `capture-pane`、`send-keys`、
  `pipe-pane`、`switch-client` 的行为不变。
- 远端不需要 pp：pp 只是把命令送过去。
- `pp ls` 对每台机器只查一次 tmux（不是每个会话查一次），并把**连不上的机器**标成
  `unreachable`（红色）而不是假装里面的会话都停了。
- 远端会话的 `cwd`、日志（`log:`）、remote-pi 名称注入都在**那台机器上**生效，
  所以路径要写远端机器的路径。
- `pp tui` 的会话列表会混进远端会话，名字后面带 ` @节点名`；预览也是抓远端 pane。
- `pp cron` 的 job 记的是会话名，投递时按会话归属找到对应节点（`--all` 会按节点分别广播）。

## 常见问题

**`pp ls` 里整台机器是 `unreachable`**
先跑 `pp node test <name>`：它会给出一句人话。常见原因依次是：密码变量没设置
（`password_env PP_X is not set`）、密钥没权限、端口写错、`sshpass` 没装、远端没有 sshd。

**`pp up` 说会话起来了但 `pp ls` 显示 off**
远端 tmux 没装，或者远端 `tmux` 的 socket 名不同（config 里的 `tmux.socket`）。
`pp node test` 会报 `tmux missing`。

**密码改了怎么办**
`pp node add <name> --host <同样的 host> --password '<新密码>'` 就是编辑，不会产生第二条记录。
更推荐改用 `--password-env`。

**怎么确认某条命令真的跑到远端了**
`pp --verbose` 会打印真实命令行；`pp attach <name> --dry-run` 打印构造出来的
`ssh … tmux attach-session …`。

**远端会话能不能也用 `/pp-*` 扩展**
扩展本身在 pi 里跑，pi 在远端那台机器上——所以远端会话里的 `/pp-ls`、`/pp-sw`
操作的是**远端**的 tmux，这通常正是你要的。面板（`pp tui`）只存在于跑它的那台机器。
