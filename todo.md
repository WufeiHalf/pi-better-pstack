# pi-better-pstack 交付清单

Playbook steps (Feature), verbatim:

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration.
3. Write the throughput checkpoint as four todo items.
4. Delegate code-writing to a subagent using your configured feature model.
5. Verify on the matching surface.
6. Rebase into small, ordered commits. Stack follow-ups.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Task todos:

- [x] 1. `how`: 子系统摸底（fitchmultz 扩展、overlay、sync 机器、fork 的 Agent 工具、Pi 扩展 API、virtual-models）— 本会话 retro 已完成同等深度的机制调查，证据在先前三轮实测
- [x] 2. `architect`: 设计已在对话中定型并经用户确认（纯镜像 + 扩展注入强制契约 + 虚拟模型预设），无并行分支需要
- [x] 3. throughput checkpoint:
  - Blocking first steps: 先落 docs/harness/pi.md（强制契约，注入唯一来源），其余全部依赖它
  - Independent workstreams: skills/ 纯镜像恢复与扩展重写互不相交，可并行；实际串行完成（同一人、上下文强耦合）
  - Shared mutable state: package.json、workflows 是共享写面，统一在收口阶段一次改
  - Smallest safe decomposition: 每个单元独立可验证（node --check / npm test / check:sync），逐个提交
- [ ] 4. 实现：契约、扩展重写（预设注册 + 模式注入 + 每轮 sticky）、纯镜像恢复、sync 脚本手术、package.json、workflows、README
  - [x] 4a. docs/harness/pi.md 强制契约
  - [x] 4b. extensions/index.js 重写
  - [x] 4c. skills/agents 恢复为 vendor 纯镜像；删除 overlay、opinion 件
  - [x] 4d. scripts/sync-pstack.mjs 去覆盖层
  - [x] 4e. package.json 重命名 + engines 放宽
  - [x] 4f. tests 修剪（去 opinion/watch-pr/overlay 用例）
  - [x] 4g. workflows 修剪（去 qualify-hosts、pi/overlays 路径）
  - [x] 4h. README 重写
- [x] 5. 本地验证：npm test + check:sync 通过
- [ ] 6. 建仓推送：gh repo create WufeiHalf/pi-better-pstack
- [ ] 7. E2E 自闭环：隔离 agent dir + 真 pi-custom-subagent + agent-workbench worktree，/pstack-mode on 后跑 healthz 任务，验证 playbook 首开、逐字 checklist、带显式模型的委派三步全过；不过就迭代
- [ ] 8. 收尾：todo 删除、报告

skip: 7. interrogate — 设计无争议面：三层强制机制均来自本会话实测证据，用户已拍板
skip: 8. Opening a PR — 目标仓库是用户自有新仓库，直接推 main，无 PR 流程
