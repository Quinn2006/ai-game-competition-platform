# v0.2.0 · 统一目录与固定主库启动（预发布）

将项目统一为 frontend、backend、database、data 结构，保留 Node.js 原生 HTTP、原生网页与 PostgreSQL，合并已发布的阶段 8 运维能力。AGENTS.md 将此结构确立为后续开发标准。

## 更新

- 根目录 start-local.cmd 一键启动固定主库、ClamAV、网站与隔离试玩。新主库使用 data/postgres；不会自动迁入、覆盖旧库。
- 作品、截图、简介原件存入 data/submissions，业务数据和文件关联仍由 PostgreSQL 管理；保留坚果云人工收集导入。
- 数据库与作品备份统一到 data/backups，支持独立库恢复演练和摘要核对；导出副本保存到 data/exports。
- 更新路径引用、迁移加载、测试和 CI；原 001—010 SQL 内容不变。data、环境配置、凭据和备份不进入源码发布。

## 使用

现有本机用户直接双击根目录 start-local.cmd。首次获取源码需要 Windows、PowerShell 7、Node.js 24+，运行 npm ci --ignore-scripts，准备 PostgreSQL 工具、ClamAV 和病毒库，然后运行 npm run local:init、再启动。运行时和病毒库不包含在源码中。详见 docs/storage-layout.md。

旧库和作品保留在原位置；本版本没有自动搬迁旧数据。Ctrl+C 停止网站和本次启动的扫描器，数据库继续运行；停止数据库使用 npm run local:stop。

## 验证及限制

合并后通过 101 个模块语法检查、49 项单元/HTTP 测试、130 条需求基线、600 次本地 HTTP 冒烟（0 错误）及真实 PostgreSQL 集成测试；目录改动另已通过备份恢复验证。新入口已实际启动，ClamAV PONG、就绪接口及主要页面返回 200，退出后网站和本次扫描器停止。

本版本为源码预发布，不包含密码、数据库、参赛作品、备份或便携运行时。未配置开机自动启动，未执行整机重启验收；生产存储、域名、真实 AI、容量灾备和完整人工验收仍待完成。独立回滚冒烟不等于跨版本或生产回滚验收。
