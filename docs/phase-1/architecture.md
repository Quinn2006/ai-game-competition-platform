# 阶段 1 工程决策与边界

2026-10-31。依据阶段 0 架构、威胁模型、留存矩阵与计划书阶段 1。用户授权开始阶段 1，并确认“暂时没有，先完成骨架”。本次没有决定 T-02—T-18 的未决业务规则。

## 工程与模块

采用模块化单体。沿用 Node.js 24 ESM、内置 HTTP 与 node:test，唯一直接运行依赖为固定版本 pg 8.23.1（MIT；npm 安装时审计 15 个包、0 个已知漏洞）。锁文件用于可重复安装；这不代表未来没有安全风险。当前没有产品页面，Next.js、TypeScript、Prisma 不作为阶段 1 前提，也不在此轮引入。未来 UI 可以消费接口，或在既有边界内替换 HTTP 层。

|位置|职责与依赖|
|---|---|
|src/server.mjs|配置、数据库、存储、HTTP 的组装与停止；不自动迁移|
|src/app.mjs|健康接口、统一错误、服务端 requestId、最小请求日志|
|src/config.mjs|环境校验；缺失依赖只允许开发/测试模式启动|
|src/platform|数据库连接、迁移、日志、错误、私有对象存储的基础接口|
|src/modules/audit|参数化最小审计写入；允许传入业务事务 client，禁止额外自由文本字段|
|migrations|001 基础 schema、环境标识和审计；不创建身份、作品或赛事表|
|prototypes|阶段 0 独立实验；不被正式服务导入|

后续领域归属：身份与资料（阶段 2）、作品/版本/扫描（3）、展示/搜索（4）、互动/试玩（5）、比赛/评审/结算（6）、通知/支持/管理（7）。各模块通过显式服务接口协作；共享基础设施不承载业务规则。不为尚未实现的模块建立空接口或虚假功能。

## 数据与安全

迁移用同一个 pg client 执行事务、事务级 advisory lock、版本及 SHA-256 校验。校验覆盖 up/down 文件；已有迁移不可直接修改，后续追加新迁移。001 的 down 只允许空审计表，存在历史时拒绝并回滚事务。迁移工具拒绝 production；真实发布流程与单独批准属于后续阶段。

`platform.environment_identity` 固定所属环境。配置要求数据库名 `ai_games_development/test/production` 与对应后缀账号，迁移和就绪探针再次检查库内标识；命名检查不能替代服务商 IAM、网络隔离和独立凭据。应用角色和迁移角色须分开配置，实际权限验证待实例可用。

审计仓库目前只允许 `system.error` / `failure`，使用一般错误 30 天分类，无 IP、UA、身份材料、任意 metadata。业务操作、安全事件和赛事决定必须在各自阶段登记事件、授权和不同保留期，不能沿用一般错误期限。HTTP 日志只写 stdout，存储、访问控制、轮转、自动到期清理和保留例外尚未接入；数据库的 expires_at 只是字段基础，不代表自动清理已完成。当前不暴露审计读写 API，也不将普通健康请求写进持久审计。

私有存储接口提供 health、put、get；key 固定为环境/区域/标识，区域仅 quarantine、review、release，禁止路径输入。put 要求驱动提供 private 与 ifAbsent（原子禁止覆盖）语义。release 仍是私有对象，不代表公开发布或审核通过。供应商驱动必须校验 IAM/ACL、限制请求时限并通过契约测试；当前无实际驱动，无公开 URL/签名链接接口，也不以本地目录冒充对象存储。审核与公开发布清单是阶段 3 的职责。

主站与游戏来源最低限度拒绝同主机和父子域，正式模式强制 HTTPS。当前还没有游戏服务；独立注册域、每作品稳定来源、预览/公开域、Cookie 与 CSP 完整验证仍在阶段 3，不能用本轮配置检查代替。

## 依据

- [node-postgres 事务文档](https://node-postgres.com/features/transactions)：事务须共用 client。
- [node-postgres 连接配置](https://node-postgres.com/features/connecting)：显式连接配置与池。
- [PostgreSQL 锁文档](https://www.postgresql.org/docs/current/explicit-locking.html)：事务 advisory lock。

以上官方文档于 2026-10-31 核对。
