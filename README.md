# pi-better-pstack

cursor 官方 [pstack](https://github.com/cursor/plugins) 在 Pi 上的发行包。目标是与 Claude Code 侧完全同一份技能文本，外加一层经过实测验证的强制机制，让模型真的照着 poteto-mode 走。

## 与上游的关系

`skills/`、`agents/`、`LICENSE`、`plugin.json` 是 cursor/plugins/pstack 的逐字节镜像（链接改写除外：指向未发布上游路径的相对链接会改写为 pinned GitHub 绝对链接）。上游没有任何 Pi 适配补丁，因此 Claude Code 侧怎么写，这里就是什么。同步机制保留上游溯源（`upstream.json` + `vendor/pstack`），每 6 小时 CI 轮询上游：有变化就 stage、跑 `check:compat` 验证，通过则自动合并 PR（全盘接受上游），失败则开 issue 等人处理；合并后可用 `git revert` 回滚任一同步点。

## 强制层（全部在扩展里，技能文本零改动）

装好后 `/pstack-mode on`，效果是三层：

1. **系统提示注入。** 每次 agent start 把 poteto-mode 全文加 `docs/harness/pi.md`（Pi 执行契约）注入系统提示，压缩不会丢。契约用操作指令写：playbook 第一步打开、逐字 checklist、`Agent` 工具委派、别名解析。
2. **每轮 sticky 提醒。** 每条用户消息附带一条简短的 checklist 提醒，落进会话记录、可审计。
3. **模型预设。** `fable`、`opus`、`sonnet`、`haiku` 注册为 Pi 虚拟模型，技能原文里的 `model: sonnet` 逐字生效。

## 模型预设配置

在 `~/.pi/agent/pstack-models.md` 里配置，一行一个：

```
fable: magpie/tokenhub/glm-5.3 @high
opus: magpie/tokenhub/glm-5.3 @high
sonnet: magpie/tokenhub/glm-5.3-flash @high
haiku: magpie/tokenhub/deepseek-v4.1-flash @low
```

格式：`alias: provider/modelId @level`。技能与上游一样按角色引用别名（feature/refactoring → `sonnet`，bug-fix/perf/hillclimb/judgment → `opus`，strongest judgment → `fable`）。effort 调整透传给物理模型。未配置的别名走 inherit-parent。改配置后重启会话生效。

## 委派

不自带 subagent 体系。委派走宿主已有的 subagent 工具（推荐 tintinweb/pi-subagents 系的 `Agent` 工具），本包通过 `pi.subagents.agents` manifest 暴露上游的 `poteto-agent` 和 `comment-sicko` 档案，subagent_type 用裸名。也不自带 loop，调度用 Pi 自己的 schedule 能力。

## 命令

- `/pstack-mode on|off|status`：模式开关，随会话分支保存。
- `/pstack-status`：对照 cursor/plugins/pstack 上游检查本包新鲜度。
- `/skill:poteto-mode` 等技能命令由 Pi 原生发现。

## 已知取舍

- `poteto-mode` 的 worktree-audit 脚本按上游只搜 Cursor transcripts，不搜 Pi 会话。
- `watch-pr` 等 Pi 专有技能不再随包发布，保持镜像纯净。

## 开发

```sh
npm test          # 单元 + 发现 + 同步回归（需要本地 @earendil-works/pi-coding-agent）
npm run check:sync  # 镜像漂移检查
npm run sync         # 从上游 stage 一次同步，--continue 发布
```

`npm test` 会在仓库里找不到 pi 时回落到全局安装，注意全局版本需 1.5.x，否则 rpc 发现测试会在旧版本上误报。
