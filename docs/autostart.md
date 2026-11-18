# 开机自启

目标：机器（或 WSL 发行版）启动后，`~/.pi/plus.yml` 里的会话自动跑起来；崩溃的会话按 `restart` 策略复活。

`pp install` 装的是一个 **oneshot** 单元/任务：开机跑一次 `pp up --config <cfg> --reconcile --quiet`，跑完就退出，agent 留在 tmux 里。`pp` 本身不常驻。

## Linux：systemd user unit

安装 `~/.config/systemd/user/pi-plus.service`：

```ini
[Unit]
Description=pi-plus: start pi agents in tmux
Documentation=https://github.com/HardyDou/pi-plus
After=default.target

[Service]
Type=oneshot
RemainAfterExit=yes
# tmux must outlive this unit: systemd would otherwise kill the sessions
# in this unit's cgroup as soon as the oneshot run finishes.
KillMode=none
WorkingDirectory=%h
Environment=PATH=<node 目录>:<项目 bin>:~/.local/bin:/usr/local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node "<pp.js 绝对路径>" "up" "--config" "<配置文件>" "--reconcile" "--quiet"
TimeoutStartSec=300
Nice=5

[Install]
WantedBy=default.target
```

几个关键点：

- **`KillMode=none` 必须有**。默认 `KillMode=control-group` 会在单元结束时清空其 cgroup，而 tmux server 是它的子进程——现象是 `Result=success` 但会话一个不剩。改之前/之后都用真实单元做过冷启动验证。
- **`RemainAfterExit=yes`**：让单元停在 `active (exited)`，`systemctl --user status` 能看到「跑过且成功」。
- **PATH 要写死**：systemd 不读你的 shell 配置，`pi`/`node` 在 nvm 里时必须显式给出目录。`pp` 会自动把「当前 node 所在目录」和「项目自己的 `node_modules/.bin`」拼进去。
- **不要依赖 `--socket`**：单元里不会传命令行 `--socket`，会话的 socket 由配置文件里的 `tmux.socket` 决定。用 `--socket` 临时调试的会话，自启时会在默认 socket 上重建。

安装/操作：

```bash
pp install                      # 写单元 + enable + start
pp install --print              # 只看内容，不落盘
pp install --watch 120          # 再装一个每 120 秒巡检的 timer
systemctl --user status pi-plus.service
systemctl --user list-timers | grep pi-plus
journalctl --user -u pi-plus.service -n 50
pp uninstall                    # 停用 + 删除
```

### 没登录也想跑：linger

systemd user unit 默认随「用户登录」启动。服务器上希望开机就跑（不等 SSH 登录）：

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger     # Linger=yes
```

`pp doctor` 会显示 `autostart  systemd, enabled, last run ok`；`pp install` 在没开 linger 时会提示这条命令。

### 定时巡检：`--watch`

装 `pi-plus.timer`：

```ini
[Unit]
Description=pi-plus: reconcile tmux sessions

[Timer]
OnBootSec=45s
OnUnitActiveSec=300s
AccuracySec=30s
Persistent=true
Unit=pi-plus.service

[Install]
WantedBy=timers.target
```

`pp up --reconcile` 每次都会跳过被手动 `down` 过的 `unless-stopped`/`on-failure` 会话，所以巡检不会违背你的手动操作。

## macOS：LaunchAgent

安装 `~/Library/LaunchAgents/com.pi-plus.plist`：

```xml
<key>Label</key><string>com.pi-plus</string>
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/env</string><string>node</string>
  <string>/usr/local/lib/node_modules/pi-farm/bin/pp.js</string>
  <string>up</string><string>--config</string><string>/Users/you/.pi/plus.yml</string>
  <string>--reconcile</string><string>--quiet</string>
</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>…</string></dict>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>~/Library/Logs/pi-plus.log</string>
<key>StandardErrorPath</key><string>~/Library/Logs/pi-plus.log</string>
```

`pp install` 用 `launchctl bootstrap gui/$UID`（失败回落 `launchctl load -w`）。`--watch N` 只会加 `StartInterval`，因为 launchd 没有独立的 timer 概念。

日志：`tail -f ~/Library/Logs/pi-plus.log`。

## WSL2：只有里面装是不够的

WSL2 的发行版**不会**在 Windows 重启后自己启动——它由某个 `wsl.exe` 调用拉起来。所以「重启后自动恢复」需要两边：

**WSL 内部（`pp install` 负责）**

```bash
# /etc/wsl.conf 里有
[boot]
systemd=true

[user]
default=youruser

pp install
sudo loginctl enable-linger "$USER"
```

**Windows 侧（需要你手动做一次）**

登录时触发一次 `wsl.exe`，启动项里放一个 `.vbs`：

```vbscript
'" %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\pi-plus.vbs
Set s = CreateObject("WScript.Shell")
s.Run "wsl.exe -d Ubuntu-24.04 -u youruser -e /bin/true", 0, False
```

或用任务计划程序：触发器「登录时」，操作 `wsl.exe`，参数 `-d <发行版> -u <用户> -e /bin/true`，勾「不管用户是否登录都运行」（配合 linger）。

`pp install` 在检测到 WSL（`WSL_DISTRO_NAME` / `WSL_INTEROP` 或内核名含 `microsoft`）时会直接打印这段提示，`pp doctor` 也会给出 `wsl` 一行提醒。

验证顺序：`wsl --shutdown`（Windows 侧）→ 重新打开 WSL → `pp ls` 应该 7/7 在跑；若没有，先看 `systemctl --user status pi-plus` 与 `journalctl --user -u pi-plus`。

## 验证自己的自启是否真的有效

不要只看 `systemctl is-enabled`，它只说明「会被执行」。真正的检验是**冷启动**：

```bash
# 把真实单元复制一份、换成临时配置和临时 socket，模拟"没有会话"的开机状态
sed 's#/home/you/.pi/plus.yml#/tmp/boot/plus.yml#' \
  ~/.config/systemd/user/pi-plus.service > ~/.config/systemd/user/pp-boottest.service
tmux -L boottest kill-server 2>/dev/null
systemctl --user daemon-reload && systemctl --user start pp-boottest.service
sleep 3 && tmux -L boottest list-sessions          # 会话应该在
systemctl --user stop pp-boottest.service
tmux -L boottest list-sessions                     # 停止单元后仍然在（KillMode=none 生效）
```

## 卸载

```bash
pp uninstall                     # 停用并删除单元/定时器（不杀正在跑的会话）
systemctl --user disable --now pi-plus.timer     # 如果装过 --watch
rm -f ~/.config/systemd/user/pi-plus.*           # 残留
```

WSL 里关掉 linger：`sudo loginctl disable-linger "$USER"`。
