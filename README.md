当前阶段6本地交付以 [阶段6手册](docs/phase-6/development.md) 和 [验证记录](docs/phase-6/verification.md) 为准。比赛入口 `/competitions`；43项测试和真实PostgreSQL验证通过，完整人工与生产验收仍待完成。分支 `codex/phase-6-competition`，下文保留此前阶段记录。

阶段4与阶段5已合入主分支；阶段5本地完整 HTTP 链路及数据库联调通过，见[阶段5联调记录](docs/phase-5/integration.md)。阶段3真实扫描验证保留在主分支；生产环境及人工验收仍待完成。下文保留此前阶段记录。

# AI 小游戏比赛平台

阶段 4 最终本地联调已完成：正式迁移、作品发布与目录、创作台资料编辑、详情内嵌试玩和撤销隐藏已接通。见 [最新验收](docs/phase-4/verification.md)。下方“等待阶段 3”说明保留为之前的独立分支历史，当前已解除。

阶段 4 独立分支：公开展示、搜索与发现已实现并完成独立验证，按用户要求等待阶段 3 完成后联调，尚未标记整体完成。见 [阶段 4 功能与接入步骤](docs/phase-4/development.md)、[验证记录](docs/phase-4/verification.md)。

当前交付：阶段 0 基线与原型、阶段 1 工程骨架、阶段 2 本地身份系统。T-02/T-08 已确认；注册、验证、登录、重置、MFA、资料、权限及账号注销已接入，真实 PostgreSQL 集成测试通过。正式邮件及未来业务模块注销联动尚待接入，未部署。
当前交付：阶段 0 基线与原型、阶段 1 工程骨架、阶段 2 身份系统、阶段 3 本地上传/技术审核/隔离试玩。33 项回归及真实 PostgreSQL 集成验证通过；已接通真实 ClamAV 并通过 EICAR、正常包及 MFA 回滚验收，补充浏览器脚本通过。生产存储/域名、真实设备兼容性及最终人工签收仍待验收，未部署。

- [阶段 3 启动、业务决定、接口边界与游戏存档接入](docs/phase-3/development.md)
- [阶段 3 测试证据与未完成验收](docs/phase-3/verification.md)
阶段4公开展示、搜索与发现已接入，见[阶段4功能说明](docs/phase-4/development.md)及[独立验证记录](docs/phase-4/verification.md)。

当前交付：阶段 0 基线与原型、阶段 1 工程骨架、阶段 2 本地身份系统。T-02/T-08 已确认；注册、验证、登录、重置、MFA、资料、权限及账号注销已接入，真实 PostgreSQL 集成测试通过。正式邮件及未来业务模块注销联动尚待接入，未部署。


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
