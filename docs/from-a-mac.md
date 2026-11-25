# 从 Mac 管 Linux 节点上的会话

pp 只在**你敲命令的那台机器**上跑；节点上什么都不用装，它用 `ssh <node> tmux …` 现场操作。
所以 Mac 上装一个 pp，配一份只含 `nodes:` 的配置，就能直接进到节点里的会话。

## 1. 装

```bash
# 需要 Node 18+（brew install node）
npm i -g pi-farm --registry https://registry.npmjs.org/
pp -V
```

## 2. 配置：`~/.pi/plus.yml`

```yaml
version: 1
nodes:
  - name: n188               # 会话里用这个名字引用
    host: 192.168.5.188
    user: user
    identity: ~/.ssh/id_ed25519_ops   # 或者 password_env: N188_PASS
sessions:
  - name: pp                 # 节点上的 tmux 会话名
    node: n188
    cwd: /data/work
    agent: pi
```

`pp` 的默认配置查找顺序：`-c` → `$PI_PLUS_CONFIG` → 当前目录的 `plus.yml` → `~/.pi/plus.yml`。

## 3. 用

```bash
pp node test n188     # 能不能连上、那台有没有 tmux / pi
pp status             # 列表里会有 NODE 列
pp attach pp          # ssh -t n188 tmux attach -t pp —— 直接进去
pp logs pp -n 40      # 不进会话也能看尾部
pp send pp "跑一下测试"
pp node 1             # 想在那台机器上操作，直接登录
```

## 4. 谁负责自愈

**跑会话的节点**负责。它自己要装 pp 并开 timer（一次就够）：

```bash
# 在 n188 上
npm i -g pi-farm --registry https://registry.npmjs.org/
pp install --watch 300          # 每 5 分钟 pp up --reconcile
systemctl --user list-timers pi-plus.timer   # 确认 NEXT 会推进
```

Mac 合上、关机、断网都不影响节点。

## 5. 关掉 Mac 也不丢的东西

- 节点上的会话与 pi 对话（`pi_session` 固定，重启回到同一个对话）
- 定时任务（`pp cron` 跑在节点上的 crontab）
- 待办（节点的 state 目录）

Mac 只是"一扇窗"。窗口关了，屋里照常。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `pp attach` 报 `unreachable` | ssh 连不上 | `pp node test n188`，看是密钥还是网络 |
| 进去后中文/宽字符错行 | 终端宽度和远端不一致 | `stty size` 对照，或 `tmux resize-window -A` |
| 会话列表里没有那台 | 配置里 `sessions` 没写 `node:` | 写 `node: n188`，或 `pp new --node n188 … --save` |
| 节点重启后会话没回来 | 节点没开 timer | 在节点上 `pp install --watch 300` |
