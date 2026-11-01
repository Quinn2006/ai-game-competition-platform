# AI 小游戏比赛平台

当前交付：阶段 0 基线与原型、阶段 1 工程骨架、阶段 2 身份系统、阶段 3 本地上传/技术审核/隔离试玩。33 项回归及真实 PostgreSQL 集成验证通过；已接通真实 ClamAV 并通过 EICAR、正常包及 MFA 回滚验收，补充浏览器脚本通过。生产存储/域名、真实设备兼容性及最终人工签收仍待验收，未部署。

- [阶段 3 启动、业务决定、接口边界与游戏存档接入](docs/phase-3/development.md)
- [阶段 3 测试证据与未完成验收](docs/phase-3/verification.md)

- [阶段 2 当前功能、启动方式与验收边界](docs/phase-2/identity.md)

- [阶段 2 范围、模块契约与后续接入](docs/phase-2/development.md)
- [阶段 2 验证与阻塞记录](docs/phase-2/verification.md)

使用 Node.js 24 与 PostgreSQL 驱动 `pg`。无依赖配置可启动健康接口和账号页面，身份 API 返回未配置；完整本地身份演示按阶段 2 手册启动：

```powershell
npm ci --ignore-scripts
npm start
```

默认监听 `http://127.0.0.1:4320`；`/health/live` 返回 200，未连接真实数据库和私有对象存储时 `/health/ready` 返回 503。停止服务使用 Ctrl+C。

- [阶段 1 启动、环境变量、迁移与人工验收说明](docs/phase-1/development.md)
- [阶段 1 验证与阻塞记录](docs/phase-1/verification.md)
- [阶段 1 架构与模块边界](docs/phase-1/architecture.md)

- [阶段 0 验证记录](docs/phase-0/verification.md)
- [130 条需求追踪与用例](docs/phase-0/requirements.md)
- [T 项决策登记](docs/phase-0/decisions.md)
- [数据分类与留存](docs/phase-0/data-retention.md)
- [架构决策](docs/phase-0/architecture.md)、[威胁模型](docs/phase-0/threat-model.md)、[本机环境](docs/phase-0/environment.md)

阶段 0 原型仍可单独运行；完整测试先执行上面的依赖安装：

```powershell
npm test
npm run check:baseline
npm run prototype
```

浏览器访问 http://127.0.0.1:4310 。另开 PowerShell 执行 ` .\scripts\browser-check.ps1`（需要现有 agent-browser 及 Chrome、可访问回环网络）。预览脚本使用独立会话 `phase0-codex-project1`；用 `agent-browser --session phase0-codex-project1 close` 结束浏览器，服务终端 Ctrl+C 停止 HTTP 服务。

权威输入为原 DOCX 与独立阶段计划书的后续 T-09 决定；只读文本提取及来源 SHA-256 在 docs/phase-0/sources。`python scripts\extract-baseline.py` 和 `python scripts\build-traceability.py` 是首次导入/生成工具，会重建生成文件，不用于保留后续手工修订；需要重建时先备份并审查 Git diff。产品功能用例目前均为待执行，不因原型通过而自动变成通过。
