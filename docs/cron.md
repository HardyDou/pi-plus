# 定时任务（`pp cron`）

把一句话按时间送进某个 tmux 会话（或者直接跑一条 shell 命令）。
调度、去重、补跑、日志都在 pp 里，`crontab` 只负责每分钟叫一次 `pp cron tick`。

```
pp cron add  建作业      pp cron ls      看作业      pp cron rm      删作业
pp cron tick 到点投递    pp cron run     立刻跑一次   pp cron logs    投递记录
pp cron install / uninstall / status      crontab 托管块
```

## 数据在哪

| 文件 | 内容 |
| --- | --- |
| `$XDG_STATE_HOME/pi-plus/cron.json`（默认 `~/.local/state/pi-plus/cron.json`） | 全部作业 |
| `$XDG_STATE_HOME/pi-plus/cron.log` | 每次投递的结果（一行一条） |
| `$XDG_STATE_HOME/pi-plus/cron.json.lock` | `tick` 的互斥锁，超过 10 分钟视为陈旧 |

作业长这样（`pp cron ls --json` 也会给这份数据）：

```json
{
  "id": "3c764f",
  "action": "prompt",              // prompt | command
  "prompt": "看一下 CI 结果",       // action=prompt
  "session": "backend",
  "socket": null,                   // 建作业时所在 tmux 服务器（null = 默认 socket）
  "configPath": "/home/user/.pi/plus.yml",
  "schedule": { "kind": "cron", "cron": "0 9 * * 1,2,3" },
  "catchUp": 7200,
  "startSession": false,
  "runs": 3,
  "lastRun": "2026-11-18T01:00:04.113Z",
  "lastStatus": "delivered"
}
```

## 三种时间表

```bash
pp cron add --session backend --in 30m "check the build"          # 一次性，相对
pp cron add --session backend --at 2026-11-21T09:00 "…"           # 一次性，绝对（本地时间）
pp cron add --session docs    --every 2h "…"                      # 固定间隔（30s…1d）
pp cron add --session docs    --cron "0 9 * * 1-5" "…"            # crontab 表达式
pp cron add --all --every 10m "忽略我的心跳检测，请继续你的任务"      # 所有在跑的会话
```

- **时区**：一律按**本机本地时间**解释，`cron.json` 里存的是 UTC（`once` 存 ISO 串，
  `lastRun` 也是），`pp cron ls` 的 `NEXT` 列显示本地时间。
- **crontab 语法**：5 个字段 `分 时 日 月 周`，支持 `*`、`n`、`a-b`、`*/n`、`a-b/n`、
  逗号列表、`mon-fri` 这类名字、周里的 `7` = 周日；宏 `@hourly/@daily/@midnight/@weekly/
  @monthly/@yearly`。**日和周同时受限时按 crontab 的"或"语义**（`0 0 1 * 1` = 每月 1 号
  *或* 每周一）。
- **`--command` 与 prompt 二选一**：`--command` 走 `sh -c`，不碰 tmux，适合健康检查；
  没有 `--command` 时 `--session` 必填（不在 tmux 里也没给就报
  `which session? pass --session <name|#>`）。

`--all` 把同一句话投给**此刻在跑的每个会话**：忙（`⠋ Working`）的会话跳过——
pi 在忙的时候只会把输入寄放在编辑框里、不会自己发出去，所以下一次 tick 再补投。

`pp cron tick` 被调用时：

1. 拿锁（`cron.json.lock`，`wx` 打开；已存在且新鲜 → 直接返回 `{skipped: true}`）；
2. 读 `cron.json`，对每个作业算 `nextRun`（`once` 看 `at`，`every` 看
   `lastRun + every`，`cron` 走 `nextCronRun`）；
3. 到期且迟到时间在 `catchUp` 之内 → 投递：
   - `action=prompt`：先确认会话存在（`startSession` 为真则先 `pp up`）。如果面板上还挂着
     `⠋ Working` 转圈行（agent 正在跑一轮），**不打字**，记
     `lastStatus = "deferred: <session> is working — the next tick will deliver"`，下一分钟再来；
     否则 `tmux send-keys -l -- <prompt>` + `Enter`。**这等于替用户敲了一句话**，目标会话里的
     agent 会当成新的用户消息处理。发送成功与否看"输入框是否被清空"——pi 在一轮没跑完时会把
     输入变成待发送草稿，盲按 Enter 什么也证明不了。
   - `action=command`：`sh -c <command>`，收 rc。
4. 成功 → `runs++`、`lastRun=now`、`lastStatus=delivered`；`deferred` 不算失败也不算运行
   （`runs`/`lastRun` 都不动，所以同一调度会自然再到期）；`once` 作业从文件里剪掉；
5. 迟到超过 `catchUp` → 不投递，记 `lastStatus = "skipped: missed by 2h 30m (catch-up 2h)"`，
   `once` 作业直接丢弃（它已经没有意义了）。

`pp cron tick` 是幂等的：同一分钟多跑几次，只会投递一次（靠 `lastRun` 推进）。

## 谁来叫 tick

### crond（默认，也是唯一后端）

```bash
pp cron install --print     # 看会写什么
pp cron install             # 写进 crontab
pp cron uninstall           # 只删托管块
pp cron status              # 装没装、下次到期、日志路径
```

写进去的块（`# >>> pi-plus cron … >>>` 与 `# <<< … <<<` 之间，pp 独占）：

```
PATH="<node 所在目录>:/usr/local/bin:/usr/bin:/bin:…"
* * * * * "<node>" "<pp.js>" cron tick --quiet >> "<cron.log>" 2>&1
@reboot "<node>" "<pp.js>" cron tick --quiet >> "<cron.log>" 2>&1
```

- 用**绝对路径的 node**，因为 crond 的 PATH 很短；块里再声明一份 `PATH`，让 pp 调
  `tmux`/`pi`/`sh` 时找得到。
- `pp cron install` **不动**你已有的行，也不整篇重写：只替换自己那两个标记之间的内容。
  重复 install 是幂等的，`pp cron uninstall` 之后 `crontab -l` 与你装之前逐字一致。
- `@reboot` 那行是多一层保险：机器重启后 crond 拉起时立刻 tick 一次，把关机期间误过的
  作业补上（受 `catchUp` 限制）。
- `--via systemd` 目前会明确报错：job 级调度没有做 systemd timer，**自启归自启、定时归
  定时**（`pp install` 管会话自启，`pp cron install` 管定时投递）。

### 手工/别处

```bash
pp cron tick                # 适合塞进任何已有的调度器
pp cron tick --now 2026-11-21T09:00   # 假装现在是这个时间（测试用）
```

## 常用操作

```bash
pp cron ls                      # id / 目标 / 时间表 / 下次 / 次数 / 上次结果
pp cron ls --json               # 机器可读
pp cron run 3c764f              # 现在就跑一次，看它到底能不能进会话
pp cron logs -n 40              # 投递日志（tail）
pp cron rm 3c764f               # 删作业
pp cron reset 3c764f            # 清 lastRun（改过时间表后用）
pp cron add --session backend --start --every 1h "巡检"   # 会话没跑时先 up 再投
```

## 在 pi 里（`schedule` 工具）

pi 扩展注册了一个**模型可见的工具** `schedule`，所以可以直接说：

> 明天早上九点提醒我看一下 risk-01 的回归结果
> 每 5 分钟检查一次 8080 端口，挂了告诉我

模型会把相对时间先算成绝对时间，再调 `pp cron add`（`--json`），把 job id 告诉你。
工具和 CLI 写同一个 `cron.json`，`pp cron ls`/`rm` 都能管。为什么是工具而不是斜杠命令：
斜杠命令只有用户能敲，模型看不见；工具描述进系统提示，模型每轮自己挑。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 到点没投递 | `pp cron status` 看 crond 块在不在；`pp cron tick` 手工跑一次看输出 |
| `crontab is not installed on this machine` | 装 cron：Debian/Ubuntu `sudo apt install cron`，macOS 自带；或改用手工 `pp cron tick` |
| 投递了但 agent 没反应 | 会话在跑但 pane 里不是 pi（或者 pi 正在出答案）。`pp logs <session>` 看目标会话当时的状态 |
| `skipped: missed by 9h` | 关机太久，超过 `catchUp`。想让它照样跑：`--catch-up 24h` |
| 作业在另一台机器的会话上 | 作业记录 `socket` 与 `configPath`，换机器/换配置后要重建（`pp cron ls` 会显示 `config` 来源） |
| 想跑完就删 | 用 `--at`/`--in`（`once` 跑完自动从 `cron.json` 消失） |
| 时区不对 | 全部按本机本地时间；容器/WSL 里先确认 `date` 与 `timedatectl` |
| `cron.json.lock` 残留 | 超过 10 分钟会被当作陈旧自动接管；急的话删掉它 |
