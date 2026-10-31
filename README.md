# AI 小游戏比赛平台

当前交付：阶段 0 需求基线与高风险原型。尚未建设正式平台或部署。

- [阶段 0 验证记录](docs/phase-0/verification.md)
- [130 条需求追踪与用例](docs/phase-0/requirements.md)
- [T 项决策登记](docs/phase-0/decisions.md)
- [数据分类与留存](docs/phase-0/data-retention.md)
- [架构决策](docs/phase-0/architecture.md)、[威胁模型](docs/phase-0/threat-model.md)、[本机环境](docs/phase-0/environment.md)

Node.js 24，无需 npm install：

```powershell
npm test
npm run check:baseline
npm run prototype
```

浏览器访问 http://127.0.0.1:4310 。另开 PowerShell 执行 ` .\scripts\browser-check.ps1`（需要现有 agent-browser 及 Chrome、可访问回环网络）。预览脚本使用独立会话 `phase0-codex-project1`；用 `agent-browser --session phase0-codex-project1 close` 结束浏览器，服务终端 Ctrl+C 停止 HTTP 服务。

权威输入为原 DOCX 与独立阶段计划书的后续 T-09 决定；只读文本提取及来源 SHA-256 在 docs/phase-0/sources。`python scripts\extract-baseline.py` 和 `python scripts\build-traceability.py` 是首次导入/生成工具，会重建生成文件，不用于保留后续手工修订；需要重建时先备份并审查 Git diff。产品功能用例目前均为待执行，不因原型通过而自动变成通过。
