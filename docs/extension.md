# pi 扩展：在会话里用 `/pp-*`

`pp` 除了命令行，还带一个 pi 扩展（`extensions/pp-tmux.js`），把 tmux 里常用的几个
`prefix` 快捷键变成斜杠命令。这样不用离开 pi 就能切会话、看别的会话在干什么、断开连接。

## 安装

扩展随 npm 包一起发布，用 pi 自己的包管理器安装即可：

```bash
pi install npm:pi-farm          # 写进 ~/.pi/agent/settings.json，之后每个会话都加载
pi -e npm:pi-farm               # 只想这一次带着它启动
pi remove npm:pi-farm           # 卸载
```

装好后在 pi 里执行 `/reload`，`/` 菜单里就会出现 `pp-ls`、`pp-sw`、`pp-quit`、
`pp-status`、`pp-peek`。启动横幅的 `[Extensions]` 一节里能看到 `pp-tmux.js`。

只在 **pi 跑在 tmux 里** 时可用：扩展靠 `$TMUX` 定位服务器和会话，不在 tmux 里会报
`not running inside tmux (TMUX is unset)`。

## 命令

| 命令 | tmux 等价 | 行为 |
|---|---|---|
| `/pp-ls` | `Ctrl-b s` | 列出所有会话（名称、路径、窗口数、当前/已死标记），上下选择、回车切换 |
| `/pp-sw <会话>` | `Ctrl-b s` + 回车 | 直接切换；支持唯一前缀（`/pp-sw risk`）、大小写不敏感 |
| `/pp-quit` | `Ctrl-b d` | 断开当前 client；**会话和 pi 都继续运行**，回来接上就能看到 |
| `/pp-status` | `Ctrl-b i` 的加强版 | 会话 / 窗口 / pane / cwd / 已连接 client 数 / socket / pi 会话 id 与文件 / remote-pi 名字 / pp 版本 |
| `/pp-peek [会话] [-n N]` | `Ctrl-b w` 的只读版 | 打印另一个会话最近 N 行输出（默认 30），不切换 |

`/pp-sw` 和 `/pp-peek` 带参数补全：输入 `/pp-sw ` 后按 Tab，会列出会话名并标注当前会话。
`/pp-peek` 省略会话名时看自己这个会话。

## 行为细节

- **只有“看着你”的 client 会被切换/断开。** 扩展先 `list-clients` 找到附着在当前会话上、
  最近活跃的那个 client，再 `switch-client -c <client>` / `detach-client -t <client>`。
  没有 client 附着（例如会话是 `up` 起来后没人 attach）时给提示而不是执行：
  `cannot switch: no tmux client is attached — attach first (pp attach <session>)`。
- **切换不会影响 pi 本身。** `/pp-sw` 只是把终端视图切走，原来那格 pane 里的 pi 继续跑；
  `/pp-quit` 同理，断开的是终端，不是进程。想真正结束会话用 `pp down <会话>`（或在
  pi 里 `/quit` 后按会话的 `restart` 策略处理）。
- **`/pp-status` 和 `/pp-peek` 的输出不进模型上下文。** 它们用 `pi.appendEntry()` 写自定义
  条目，只在界面上渲染；`/pp-peek` 不会把别的会话内容塞进当前对话。
- **非交互模式（`pi -p`）** 下两个输出类命令改为写到 stdout，方便脚本化：

  ```bash
  tmux new -d -s probe -c ~/code/api "pi -e npm:pi-farm -p '/pp-status'"
  ```

## 实现

| 文件 | 作用 |
|---|---|
| `extensions/pp-tmux.js` | 扩展入口：注册 5 个命令、调 tmux、渲染结果 |
| `src/ppui.js` | 纯函数：`$TMUX` 解析、会话标签、前缀匹配、`/pp-peek` 参数解析、截断输出、挑 client |

`pp` 的执行逻辑和扩展互不依赖：扩展直接调 `tmux`，不经过 `pp` 二进制，所以 tmux 里的
进程用哪个版本的 `pp` 都不影响它（`/pp-status` 显示的 `pp` 版本来自扩展所在包的
`package.json`）。

测试：`node --test test/ppui.test.js`（解析、标签、匹配、参数、截断、client 选择）。

## 常见问题

| 现象 | 处理 |
|---|---|
| `/pp-*` 不在命令列表里 | 没装或没加载：`pi list` 看有没有 `npm:pi-farm`，装完 `/reload` |
| `not running inside tmux (TMUX is unset)` | pi 不在 tmux pane 里；先 `pp attach <会话>` 或 `tmux new -s x` 再起 pi |
| `cannot switch: no tmux client is attached` | 会话是后台起的、没人 attach；`pp attach <会话>` 接上再来 |
| `/pp-ls` 列表里没有某个会话 | 它在另一个 tmux socket 上；扩展只列当前 `$TMUX` 那个服务器的会话 |
| 切换后回到原点 | `/pp-sw` 换的是 client，pi 在原来的 pane 里继续跑；`/pp-ls` 里带 `(current)` 的就是 pi 所在会话 |
