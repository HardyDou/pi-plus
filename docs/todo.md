# 待办：哪个会话在等你

一个 pi 会话卡在问题上时，你多半不在看它。`pp todo` 是那张"谁在等我"的清单。

## 待办从哪来

三种来源，前两种**不需要模型记得**：

| 来源 | kind | 触发 |
|---|---|---|
| pi 弹出阻塞式提示 | `prompt` | `ui_prompt_start`：`ctx.ui.select` / `confirm` / `input` / `editor` 出现在屏幕上，会话确实停在那里等你按键 |
| 一轮跑完，结尾是个问题 | `settled` | `agent_settled` 且最后一段话以 `?`/`？` 结尾，或含"请确认、要不要、是否"等词 |
| 手写或模型主动登记 | `manual` | `pp todo add "…"`，或模型调用 `todo` 工具 |

会话重新跑起来（`agent_start`）时，它自己的未完成待办会自动变成 `done` —— 你显然已经回答过了。

想调节噪音大小：

```bash
export PP_TODO_SETTLED=question   # 默认：只记结尾是提问的
export PP_TODO_SETTLED=always     # 每次跑完都记一条
export PP_TODO_SETTLED=off        # 只记阻塞提示和手工登记
```

## 用法

```bash
pp todo                       # 需要我决策的（= pp todo ls）
pp todo ls --all              # 连已完成的
pp todo ls --session risk-01  # 只看向某个会话
pp todo attach 2              # 进入第 2 条对应的会话（顺手标记 seen）
pp todo done 2 5              # 办完了，可以一次多条
pp todo rm 2                  # 从清单里删掉（不是完成）
pp todo clear                 # 清掉已完成的；--force 连未完成的一起清
pp todo add "review the plan" --session backend
pp todo ls --json
```

`#` 是稳定的：按创建时间倒序（最新在前）编号，包含已完成的行，所以两次命令之间同一个号指的是同一条。也可以用 id 前缀：`pp todo done 4f2a`。

在 pi 里还有 `/pp-todo`：直接弹出列表，选中就切到那个会话。

## 数据在哪

```
$XDG_STATE_HOME/pi-plus/todos.json      # 默认 ~/.local/state/pi-plus/todos.json
```

```json
{
  "version": 1,
  "todos": [
    {
      "id": "85df2f",
      "session": "risk-01",
      "kind": "settled",
      "title": "要我现在合并到 main 吗？",
      "body": "…最后一段完整回复…",
      "state": "new",
      "createdAt": "2026-11-20T09:45:12.331Z",
      "updatedAt": "2026-11-20T09:45:12.331Z"
    }
  ]
}
```

`state` 是 `new` / `seen` / `done`。`doneAt`、`closedBy` 只在完成时出现（`closedBy: "answered"` 表示是会话重新跑起来时自动关掉的）。

写文件是"临时文件 + rename"，所以 pi 在写的时候 `pp todo` 读到的永远是完整 JSON。

## 去重规则

同一个会话、同一种 kind、同一个标题，只要还没完成，就不会重复入列 —— 只会刷新时间和正文。所以一个会话反复弹同一个提示，清单里只有一行。

同一个问题被回答后又问了一次，会产生新的一行（旧的已经 `done`）。

## 已知边界

- 只有**会话重新开始跑**才算"已回答"。你用 `Esc` 关掉提示、但没让会话继续跑，那条 `prompt` 待办会留着 —— 这也是对的，问题确实还没解决。
- `(offline)` 标记表示这个会话当前不在运行（按 `pp` 看到的 tmux 判断）。待办不会因为会话被杀而消失，因为"它问过你什么"仍然有效。
- 待办是**本机**的：跨机器的 mesh 不会同步待办列表。
- 没有桌面通知（见 README 的"通知"讨论）：目前靠 `pp todo`、`/pp-todo` 和你自己看状态栏。
