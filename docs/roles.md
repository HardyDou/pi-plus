# 角色（`role`）：给会话贴一个"它是干什么的"

`role` 是一段 ≤24 字符的自由文本，挂在会话或机器上，用来**筛、排、批量动手、审计、追问**。
它不是权限，不参与调度判断 —— 一个 `role` 写错不会让任何东西起不来，只会让你在 3am 找错会话。

## 一分钟

```bash
pp role risk-01 risk        # 贴
pp role --list              # 看有哪些标签、各几个、还有谁没贴
pp role risk-01 -           # 撤掉（`-` 或 `none`）
```

配置里就是一行：

```yaml
sessions:
  - name: risk-01
    cwd: ~/code/risk
    role: risk
```

机器级默认值（新会话自动继承，远端会话本来也看不见）：

```yaml
nodes:
  - name: p201
    host: 192.168.5.201
    user: ops
    defaults:
      role: prod
```

优先级：会话上的 `role:` > 机器 `defaults.role` > 无。

## 一个标签能做什么

| 想要 | 命令 |
|---|---|
| 只看这一类 | `pp status --role prod` |
| 把同类排在一起 | `pp status --sort role`（配置里 `sort: role`；`pp tui` 的 `s` 第四档） |
| 批量起 / 停 / 重启 | `pp up --role prod`、`pp down --role prod`、`pp restart --role prod` |
| 批量看日志 | `pp logs --role prod -f` |
| 批量投递一句话 | `pp send --role prod "上线窗口十分钟后开始"` |
| 定时任务瞄准一个标签 | `pp cron add --role prod --every 30m "站会时间到"` |
| 审计一个标签 | `pp audit --role prod` |
| 追问"它为什么是这样" | `pp why --role prod` |
| 面板里筛 | `pp tui` 按 `/` 输入标签 |

批量动词对 `--role` 与 `--node`、`--tag` 是**同一层**的过滤器，可以叠加：
`pp logs --role dev --node b111 -f` 是"b111 上 dev 那几台"。

## 命名：几条经验

- **小写、短**：`prod`、`test`、`dev`、`infra`、`release`、`risk`。它们在表格里占一列，长了会把布局挤歪。
- **按"谁负责/在哪跑"分组，不按"跑什么程序"**：`role: pi` 没有信息量，`role: prod` 有。
- **一个会话一个标签**。这是刻意的限制：两个标签就有"与还是或"的问题，而 3am 不该回答这种问题。
  真需要二维分组，用机器 `tags:`（`pp node ls --tag prod`）配会话 `role:`。
- **别用大小写区分**：`prod` 与 `Prod` 在过滤时是两个标签。`pp check` 会把它当问题报出来：

  ```
  error: roles "prod" (a) and "Prod" (b) differ only by case — pick one: pp role <name> <label>
  ```

- **贴标签是判断，不要自动化**。工具能推导的是"在哪台机器"（`--node`）和"是什么角色"（`--hostname` 里的
  `prd-`/`test-`/`dev-` 前缀），推导不了"谁来负责它"。所以 `pp adopt`、`pp new` 都只接受显式的 `--role`。

## 常见问题

**贴了标签但批量命令没反应？**
先 `pp role --list` 看标签的实际拼写（大小写敏感），再 `pp status --role <label> --json` 看命中的是哪些。

**`pp up --role prod` 报 `no session has role "prod"`？**
报错里会列出当前在用的标签。若列表为空，说明一个都没贴。

**机器换了标签，已有会话会跟着变吗？**
不会。会话一旦写了自己的 `role:`，机器的 `defaults.role` 就不再管它 —— 这是"显式优先"的同一套规则。

**标签会影响 `pp down` 的安全性吗？**
不会。`guarded`（机器级）与 `drained`（维护窗口）才是安全阀，`role` 只是分类。
