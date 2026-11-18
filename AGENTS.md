# pi-better-pstack

上游镜像纪律：`skills/`、`agents/`、`LICENSE`、`plugin.json` 只能由 `scripts/sync-pstack.mjs` 从 `vendor/pstack` 生成，禁止手改（链接改写由脚本完成）。所有 Pi 适配必须落在 `extensions/index.js` 或 `docs/harness/pi.md`，不得以任何形式 patch 上游文件。

改动验证：`npm test` 全绿后才能提交；`npm run check:sync` 必须通过。上游同步走两段式（`npm run sync` stage，评审 `review.json` 后 `--continue` 发布），发布前 CI 会自动跑一遍检查。

`docs/harness/pi.md` 是注入的唯一来源，措辞用操作指令（read before / first action / omit model），不写「when needed」式许可性条款——这是本包与 fitchmultz 版的根本差异，实测中许可性措辞让 playbook 路由失败。
