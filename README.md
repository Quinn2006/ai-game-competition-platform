2026-11-03：已整理为 frontend、backend、database、data。新主库独立初始化在 data/postgres，旧库未迁入。当前启动、坚果云材料导入、备份恢复与目录标准以 [本地运行手册](docs/storage-layout.md) 为准；下文保留历史阶段记录。

2026-11-02 最新决定与联合验收以 [阶段6/7合并及本地账号说明](docs/phase-7/integration.md) 为准：注册无需邮箱验证，全部通知仅站内；取消真实邮件验收；本地AI隐私流程已测，真实AI供应商仍未配置。

阶段7本地运营后台、通知公告、反馈与服务接口已实现；真实邮件/AI和阶段6联调待验收。见[开发说明](docs/phase-7/development.md)与[验证记录](docs/phase-7/verification.md)。
当前阶段6本地交付以 [阶段6手册](docs/phase-6/development.md) 和 [验证记录](docs/phase-6/verification.md) 为准。比赛入口 `/competitions`；43项测试和真实PostgreSQL验证通过，完整人工与生产验收仍待完成。分支 `codex/phase-6-competition`，下文保留此前阶段记录。

阶段4与阶段5已合入主分支；阶段5本地完整 HTTP 链路及数据库联调通过，见[阶段5联调记录](docs/phase-5/integration.md)。阶段3真实扫描验证保留在主分支；生产环境及人工验收仍待完成。下文保留此前阶段记录。

# AI 小游戏比赛平台

## 一键本地启动

双击根目录 `start-local.cmd`。入口会启动 `data/postgres/` 固定主库（默认端口 55440）、ClamAV、网站与隔离试玩；不会自动覆盖旧库。作品保存在 `data/submissions/`。

首次获取源码：准备 Node.js 24+、PowerShell 7、PostgreSQL 工具、ClamAV 和病毒库，执行 `npm ci --ignore-scripts`、`npm run local:init` 后再启动。本机已有新主库时不要重新初始化。

迁移后补建本地内置账号，已有账号保持不变。

|角色|账号|初始密码|
|---|---|---|
|管理员|Admin06|abcd123456|
|评委|Judge1、Judge2、Judge3、Judge4、Judge5|abcd123456|

账号名不区分大小写，直接在登录页输入即可。Admin06首次登录仍须设置TOTP两步验证。评委已有judge角色，具体作品仍由比赛分配。初始化只接受回环development库，数据库保存各自独立加盐的密码哈希；这些是公开的本地演示凭据，不能用于正式部署。重复启动不重置密码、不覆盖已有角色、不恢复停用或注销账号；同名已有账号保留原样。普通用户注册仍使用邮箱格式和15—128字符密码。当前本地密码重置工具支持这些账号名。


启动后访问 http://127.0.0.1:4320/discover 。Ctrl+C 关闭网站和本次启动的扫描器，数据库保持运行；停止数据库使用 `npm run local:stop`。旧版本的 `-State`、`-DatabasePort` 参数不再用于新入口。

[目录与操作手册](docs/storage-layout.md) · [v0.2.0 发布说明](docs/release-v0.2.0.md) · [后续开发约定](AGENTS.md)

## 历史阶段记录

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
- [阶段 8 本地运维与部署手册](docs/phase-8/runbook.md)
- [阶段 8 验证、需求核对与上线阻塞](docs/phase-8/verification.md)
- [阶段 1—8 主分支联调验收](docs/phase-8/integration.md)

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
