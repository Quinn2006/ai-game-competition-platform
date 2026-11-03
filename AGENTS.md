# AI 小游戏比赛平台开发约定

本项目后续开发沿用 docs/storage-layout.md 中的结构，不另建平行项目骨架。

- frontend/：原生 HTML、CSS、浏览器 JavaScript；backend/src/：Node.js 原生 HTTP、业务 modules 和基础设施 platform。未经明确要求不更换技术栈。
- database/migrations/：数据库设计与迁移。已应用的迁移不改写，新增变更使用后续编号。
- 参赛者、团队、作品、版本、审核、互动、有效试玩、评分、排行的权威数据在 PostgreSQL。
- data/postgres/ 是本机主库；data/submissions/ 存放作品和附件；data/backups/ 存放备份；data/exports/ 存放导出。
- 坚果云保留为收集入口，导入沿用校验、扫描、审核和归属权限，不直接公开收集文件。
- 根目录 start-local.cmd / start-local.ps1 是 Windows 日常启动入口。目录调整必须同步更新启动脚本、静态资源路径、检查脚本、测试和 CI。
- data/、真实 .env、密码、会话密钥、作品与备份不得提交。配置示例只能含非敏感示例，禁止把真实数据打进 Release。
- 不手动修改 PostgreSQL 内部文件；迁移采用逻辑备份和恢复验证。旧实例未经明确要求不搬迁、不覆盖。
- 现有 scripts/、tests/、docs/、prototypes/ 继续保留；仅用 tmp/ 和 preview/ 保存可丢弃产物。
- 验证执行 npm run check、npm test、npm run check:baseline；影响数据库时使用独立测试库，不能运行破坏性测试到主库。启动改动还应实际启动并检查 HTTP 与退出清理。
- 发布说明区分本地验证与生产验收。当前预发布不代表生产部署、真实 AI 或灾备已完成。
