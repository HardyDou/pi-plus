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
> `tags` / `guarded` / `drained` / `base_path` / `defaults` 是配置文件里的字段，直接手写 YAML；`pp` 的命令行只为最常用的几项提供旗标（`--host/--port/--user/--identity/--note`）。

| `guarded` | | `true` 时这台机器上的会话拒绝 `pp down` / `pp rm`（除非 `--force`） |
| `base_path` | | 这台机器的根目录，会话写相对的 `cwd` 时拼在它下面 |
| `defaults` | | 这台机器的会话默认值：`agent` / `restart` / `remote_pi_mode` |

`password` 与 `password_env` 只能给一个；两个都写会报错。同时给 `identity` 和
`password` 只给警告（ssh 会先用密钥）。

## 一台机器的默认值：`base_path` 与 `defaults`

机群大了以后，每条会话都重复 `cwd: /srv/xxx`、`restart: unless-stopped` 是噪音。
把机器共同的部分写在节点上，会话就只剩"叫什么、在哪个目录"：

```yaml
nodes:
  - name: prod-01
    host: 10.0.0.11
    base_path: /srv/apps        # 相对 cwd 的根
    defaults:
      agent: node /srv/agent.js # 这台机器上 pi 不在 PATH 里时的替代
      restart: unless-stopped
      remote_pi_mode: env

sessions:
  - name: prod-api
    node: prod-01
    cwd: api                    # → /srv/apps/api
  - name: prod-web
    node: prod-01
    cwd: web                    # → /srv/apps/web
```

优先级：**会话自己写的 > 节点 `defaults:` > 顶层 `defaults:`**，所以一台机器可以整体
不同，又不用把每个字段都抄一遍。`cwd` 以 `/`、`~`、`./`、`../` 开头时按原样用，
只有相对路径才会拼到 `base_path` 下（远端目录是否存在由远端决定，`pp up` 会报错，
本地则会在启动前就拒绝）。

`defaults` 里只认这几个键：`agent`、`restart`、`remote_pi_mode`、`env`、`args`、`role`。

`role` 尤其值得放在机器级：远端会话你在本机看不到，逐个贴标签很不现实，而
"这台机器上的会话都算 prod"通常是**构造成立的事实**，不是人工判断。

```bash
pp node show p201                        # defaults 里能看到
pp status --role prod                    # 立刻按语义筛（远端会话按名字显示）
```
写别的会警告并忽略（例如 `cwd` —— 那是每条会话自己的事）。

`role` 也在其中：一台测试机上的会话通常都是同一个角色，写在机器上一次就够：

```yaml
nodes:
  - name: test-01
    host: 10.0.0.21
    defaults:
      role: test
sessions:
  - name: test-api
    node: test-01        # → role: test
    cwd: /srv/api
  - name: test-report
    node: test-01
    cwd: /srv/report
    role: report         # 会话写的赢
```

`pp role --list` 会把继承来的标签一起算在内（它看的是解析后的配置，不是文件原文），
所以列出来的就是 `--role` 真正能筛到的词。

命令行等价物：

```bash
pp node show prod-01          # 看它现在带的默认值
pp new api --node prod-01 -C api --save   # 落到 /srv/apps/api
```

### 把大家都要的参数写成模板

`defaults` 里还能放 `env` 和 `args`——这两样最常被抄来抄去（代理变量、`--model`）：

```yaml
nodes:
  - name: t114
    host: 192.168.5.114
    user: ops
    base_path: /srv
    defaults:
      agent: pi
      restart: unless-stopped
      env:
        HTTP_PROXY: http://127.0.0.1:7890
      args: ["--model", "deepseek"]
sessions:
  - name: api
    node: t114
    cwd: apps/api
    env:
      LOG_LEVEL: debug
    args: ["--verbose"]
```

这台机器上跑起来的 `api` 会话，实际是：

```
env HTTP_PROXY=http://127.0.0.1:7890 LOG_LEVEL=debug … pi --model deepseek --verbose
```

三条规则要记住：

| 谁 | 怎么合并 |
| --- | --- |
| `env` | 三层叠加：顶层 `defaults.env` → 机器的 `defaults.env` → 会话自己的 `env`，同名的后者赢 |
| `args` | **堆叠不覆盖**：机器模板的参数在前，会话自己的参数接在后面 |
| `cwd` | 相对路径按机器的 `base_path` 解析（`api` → `/srv/api`），绝对路径原样 |

不会顺手清掉模板（编辑时未提到的字段一律沿用旧值）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `pp node ls` | 表格：名字、`user@host:port`、认证方式、上面有几个会话、备注 |
| `pp node show <name>` | 详情：完整字段（密码打码）+ 用到它的会话列表 |
| `pp node add <name> …` | 新增；同名视为编辑，会报告改了哪些字段 |
| `pp node rm <name>` | 删除；还有会话指向它时**拒绝**，`--force` 才硬删（会留下悬空引用） |
| `pp node test <name>` | 一次 ssh 往返，报告机器体检结果（`--all` 测全部） |
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
```

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

### 一条命令看清整排机器

```bash
$ pp doctor --nodes
MACHINE    TARGET              PING   TMUX  LOAD  UP   SESSIONS  DISK  MEM  CONFIG
✓ edge240  user@192.168.5.240  163ms  3.4   0.06  49d  0         33%   21%  -
✓ t114     user@192.168.5.114  165ms  3.4   0.73  49d  2         63%   28%  1/1 +1
```

`CONFIG` 那一列回答的是"配置还描述得住这台机器吗"：`1/1` 是你给它列的会话都在跑，
`0/1` 是有会话没起来（`pp up`），`+1` 是它上面跑着一样你没写下来的东西（`pp adopt`）。
`-` 表示这台机器你不打算放会话。

### 收编机器上已有的会话

跟同事共用的机器上，往往先有 tmux 会话、后有人写配置。`pp adopt` 就是把"实际在跑的"
变成"配置里写着的"：

```bash
$ pp adopt --all --node prod-01 --dry-run
  + build   /srv/build   agent:pi   node:prod-01
  + watch   /srv/watch   agent:bash   node:prod-01
[dry-run] would write 2 session(s) to ~/.pi/plus.yml
```

不会重启任何东西；`pp ls` 里 `(not in config)` 的那些行从此不再是例外。

### 把会话挪到另一台机器

```bash
$ pp mv backend --node prod-01
stopped backend @dev-01
started backend → tmux:backend  cwd:/data/app
moved backend: dev-01 -> prod-01
the pi conversation stays on dev-01 — prod-01 starts a fresh one
```

改的只是配置里那一行 `node:`。`--local` 把它挪回本机，`--cwd` 顺便换目录（会在目标机上
检查目录存在）。目标机不可达、或那台机器上已经有同名会话，就拒绝（`--force` 替换）。
pi 的历史留在旧机器，这一条会在输出里说明，不会让人事后才发现。

### 机群体检：一次看清整排机器

```bash
$ pp doctor --nodes
MACHINE    TARGET              PING   TMUX  LOAD  UP  SESSIONS  DISK  MEM
✓ edge240  user@192.168.5.240  154ms  3.4   0.00  49d  0         33%   20%
✓ t114     user@192.168.5.114  363ms  3.4   0.76  49d  0         63%   29%
✗ p202     user@192.168.5.202  down   -     -     -   -         -     -
  p202: ssh: connect to host 192.168.5.202 port 22: Connection refused

2/3 reachable  0 carrying sessions  slowest 363ms
```

一次 ssh 打一台（并行发出），回答的是"哪台机器不对劲"，而不是"我连不连得上"：
`--json` 里每台机器带完整 `probe`，失败的那台退出码为 1（适合放进巡检脚本）。

`pp node test <名>` 仍然是单台的详细探测（逐项打印），两者的区别是"体检表"和"化验单"。

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

## 那台机器重启了，会话怎么回来

**远端不需要装 pp。** 那台机器上没有任何东西会去启动这些会话 —— 拉起它们的永远是"这一侧"：

```bash
pp node test t114      # 先确认它回来了：reachable — tmux 3.4 · pi installed (350ms)
pp why --node t114     # 每台机器、每个会话的结论（down 的行会写上原因）
pp up --drift          # 只起"该起没起"的，已经跑着的不动
```

想让它在重启后自己回来（不必等人发现）：

```bash
pp cron add --heal --every 5m
```

`--heal` 在本机的 cron tick 里跑：它按配置算出每台机器"该有却没有"的会话，用 ssh 过去
`tmux new-session`。所以**远端重启后最多五分钟自己回来**，代价是每条 tick 都要 ssh 一次。

两个会挡住自愈的东西，都是设计：

- `restart: no` 的会话不会被 `--heal` 拉起（那是不该自启的）
- `pp node drain <machine>` 期间的会话不会被拉起（维护窗口，见下一节）

## 维护一台机器：`pp node drain`

`guarded` 防的是"手滑把它停了"，`drain` 防的是反过来的那件事——**手滑让它起来**。

打补丁、换内核、重启机器的时候，自启单元和 `pp cron --heal` 会非常勤快地把会话拉回来，
而它们出发点是好的，只是时机不对：

```bash
pp node drain t114
# drained t114 — pp up, the autostart unit and --heal leave its sessions down
```

接下来 `pp up`、`pp up --drift`、开机自启、`pp cron --heal` 都会跳过这台机器的会话，
`pp status` 把它们显示成 `off (drain)`（和"有人特意停了"的 `off (hand)` 区分开）。
它**不会**替你停掉已经在跑的会话——要停就明说：

```bash
pp down --node t114
```

机器弄好了，放回服务：

```bash
pp node undrain t114
pp up --node t114          # 立刻拉起来（否则下一次 up / 自启 / tick 才管）
```

`pp node ls` 会给维护中的机器加前缀 `~`；`pp node show t114` 的 `drained` 一行也是这个信息。

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
