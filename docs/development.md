# 开发指南

零运行时依赖，纯 ESM，Node ≥ 18。改完跑 `npm test`，端到端再跑一次 `./test/e2e.sh`。

## 目录

```
bin/pp.js            CLI 入口：参数解析、命令分派、退出码
src/commands.js      各子命令实现（up/down/restart/status/attach/logs/send/
                     check/doctor/init/install/uninstall/new）
src/config.js        YAML → 归一化配置、argv 构建、名字解析、序号解析
src/yaml.js          零依赖 YAML 子集解析器
src/tmux.js          tmux 封装（run/create/kill/list/capture/send/pipeLog/attach）
src/remote-pi.js     <cwd>/.pi/remote-pi/config.json 读写
src/state.js         手动停止记录（XDG state）
src/autostart.js     systemd / launchd 模板与安装
src/help.js          命令表（help 文本与补全的唯一来源）
src/example.js       init 的模板配置
test/                单元测试 + e2e.sh
docs/                技术文档
```

## 跑起来

```bash
git clone https://github.com/HardyDou/pi-plus && cd pi-plus
npm test                       # 41 个单测，不需要 tmux
./test/e2e.sh                        # 541 项端到端，需要 tmux + pi，约 5 分钟
PP_E2E_ONLY='^(drift|tui)$' ./test/e2e.sh   # 只跑这两节（调试用，见下）
node bin/pp.js --help
```

改一个功能时不想等五分钟：`PP_E2E_ONLY` 是个正则，只有标题匹配的分节会真正执行，其余分节会打印 `(skipped)` 并把检查计入 `SKIP`。**这不是"小套件"** —— 分节体内的准备代码仍会跑（检查需要它们），所以被过滤掉的依赖会让某些检查假失败。它的用途是"改一处、看那一处"，最后仍然要跑一次完整的。

`e2e.sh` 会在隔离环境里跑，不会碰你的真实会话：独立 socket（`pfe2e`）、独立配置（`/tmp/e2e-pifarm/plus.yml`）、独立 state 目录，退出时 `trap` 清理。它会真的装一个 `pi-plus.service` 再删掉，所以需要 systemd（或至少 `systemctl --user` 能跑）。

想手动试：

```bash
S=/tmp/scratch && mkdir -p $S/demo && cat > $S/plus.yml <<'YAML'
version: 1
tmux:
  socket: pdev
defaults:
  agent: bash
sessions:
  - name: demo
    cwd: /tmp/scratch/demo
YAML
PI_PLUS_CONFIG=$S/plus.yml node bin/pp.js up
PI_PLUS_CONFIG=$S/plus.yml node bin/pp.js logs demo
tmux -L pdev kill-server
```

## 改代码时的规矩

- **tmux 目标**：`has-session` / `kill-session` 用 `=name`；`send-keys` / `capture-pane` / `pipe-pane` / `set-option` 必须用 `paneTarget(name)`（`=name:`，带冒号）。写错不会报错，只会「什么都没发生」——历史上 `log:` 不写文件就是这个原因。
- **只读查询要传 `readOnly: true`**：否则 `--dry-run` 时 tmux 命令被短路成 `true`，`sessionExists()` 会把所有会话报成「在跑」。
- **所有面向用户的文本**走 `ui`（`makeUi({quiet, json, color})`），否则 `--json` / `-q` 会漏。
- **help 文本不要手写两份**：命令、选项、示例都写进 `src/help.js` 的 `COMMANDS`，`renderOverview` / `renderCommandHelp` 自动生成，`test/help.test.js` 会检查覆盖是否完整。
- **新增配置字段**：加进 `SESSION_KEYS`（否则出现 `unknown key` 警告）、在 `normalizeSession` 里解析、更新 `docs/configuration.md` 的字段表、补一条 `test/config.test.js`。
- **改行为要改文档**：README 的生命周期表、`docs/` 对应章节、`src/help.js` 的备注，三处一致。
- 配置解析一定要「宽进严出」：未知键警告但不失败，非法值报错并指出字段名。

## 测试策略

| 层 | 位置 | 覆盖什么 |
|---|---|---|
| 解析器 | `test/yaml.test.js` | 嵌套、流式、引号、注释、块标量、tab 缩进报错 |
| 配置归一化 | `test/config.test.js` | 默认值、名字规整、argv 顺序、restart 策略、共享 cwd 警告、序号解析 |
| 模板 | `test/autostart.test.js` | systemd 单元（`KillMode=none`、PATH 去重、`--reconcile`）、timer、launchd plist |
| 帮助 | `test/help.test.js` | 每个命令都有完整帮助页、别名解析、拼写建议 |
| 新会话 | `test/new.test.js` | 名字规整、`--save` 往返、拒绝无 `sessions:` 的文件 |
| 状态 | `test/state.test.js` | 标记/清除、按配置隔离、坏 JSON 容错 |
| 端到端 | `test/e2e.sh` | 真 tmux + 真 pi + 真 systemd unit 装/卸 |

单元测试一律用 `node:test` + `node:assert/strict`，不引测试框架，也不 mock 文件系统之外的东西（`mkdtemp` 就够）。

## CI

`.github/workflows/ci.yml`：ubuntu + macos × node 18/20/22，跑 `npm test`、`node bin/pp.js --version`、对模板配置跑一次 `check`（允许失败）。e2e 不进 CI（需要 tmux/pi，且会装单元）。

本地提交前：

```bash
npm test && node bin/pp.js --help >/dev/null && git diff --check
```

## 发布

包名 `pi-farm`，可执行文件 `pp`，版本在 `package.json` 和 `bin/pp.js` 共用前者。

npm 对开启 2FA 的账号用**分阶段发布（staged publishing）**：`npm publish` 只上传，要再执行一次 `npm publish` 才转正，否则会看到

```
npm error code E409 ... Cannot publish over previously staged version "0.2.0"
```

流程：

```bash
# 1. 改版本
npm version patch            # 生成 tag
# 2. 全绿
npm test && ./test/e2e.sh
# 3. 发布（注意 registry、注意要 !bypass 2FA 的 granular token）
npm publish --registry https://registry.npmjs.org/
npm publish --registry https://registry.npmjs.org/    # 第二次 = 转正 staged 版本
# 4. 校验
npm view pi-farm version dist.tarball bin
npm i -g --prefix /tmp/pp-verify pi-farm --registry https://registry.npmjs.org/
/tmp/pp-verify/bin/pp -V
# 5. GitHub release
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes
```

注意：

- token 需要 `Read and write` + **`bypass 2fa`**，否则 `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required`
- 带 `bypass_2fa` 的 token **不能** `npm unpublish`（403），发布前测干净
- `0.0.0-stage` 这类占位版本是 npm 的 staged publishing 产物，正常现象

发布只改了名字/描述时，GitHub 上的 release notes 记得改成给用户看的话，别留默认 commit 列表。

## 常见坑（代码层面）

- `execFile` 的 `env` 是**替换**不是合并，必须显式带上 `PATH`（`Tmux.run` 里已经处理）
- `tmux -L <socket>` 与默认 socket 完全隔离，测试里别混用
- `systemd` oneshot 结束会清 cgroup，tmux 会被连坐杀死 → 单元必须 `KillMode=none`
- macOS 上 `launchctl bootstrap` 失败时回落 `load -w`，两条路都要留日志
- 网络路径（`/mnt/c/...`）上的 `cwd` 会让 pi 很慢，不属于 bug
