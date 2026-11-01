# 阶段 1 开发与验收手册

2026-11-01 更新：阶段 2 已追加 003_identity、004_audit_retention；up 当前应用四条迁移，down 每次仅回退最新一条且拒绝对应非空数据。已在便携 PostgreSQL 18.6 上实测。当前身份服务启动以 docs/phase-2/identity.md 为准，下文保留阶段 1 环境说明。

前提：Node.js 24、npm，工作目录 `D:\AI-project\Codex-project1`。没有 PostgreSQL 也能启动骨架；业务功能与完整就绪尚不可用。

## 启动及本地检查

```powershell
Set-Location D:\AI-project\Codex-project1
npm ci --ignore-scripts
npm run check
npm run check:baseline
npm test
npm start
```

另一个终端：

```powershell
Invoke-WebRequest http://127.0.0.1:4320/health/live
Invoke-WebRequest http://127.0.0.1:4320/health/ready -SkipHttpErrorCheck
```

第一项应为 200 / alive。当前无数据库/供应商存储驱动，第二项应为 503 / DEPENDENCIES_NOT_READY。根路径是统一 JSON 404；本阶段没有网页界面。Ctrl+C 停止；`npm run dev` 支持自动重启。开发端口与阶段 0 的 4310—4312 分离。

## 环境变量

`npm start` 与迁移命令可读取根目录 `.env`，集成测试可读取 `.env.test`；文件均被 Git 排除。本轮不创建真实凭据文件，不提供会被误运行的占位连接串。无依赖开发模式无需任何环境变量。

|变量|默认/约束|
|---|---|
|APP_ENV|development；仅 development、test、production|
|HOST / PORT|127.0.0.1 / 4320；开发与测试只允许回环地址，production 可由部署层指定 0.0.0.0|
|MAIN_ORIGIN|开发默认 http://127.0.0.1:4320；显式配置必须是完整 origin，不能有路径或凭据|
|GAME_ORIGIN|开发默认 http://127.0.0.2:4321；仅边界配置，不启动游戏服务；阶段 3 再细化每作品域名|
|DATABASE_URL|无默认；postgres/postgresql URL；数据库必须名为 ai_games_加当前环境；账号后缀为下划线加当前环境；不接受 URL 查询参数|
|DATABASE_TLS|开发/测试默认 disable；production 必须 verify-full，使用受信任证书；私有 CA 可通过 Node 的 NODE_EXTRA_CA_CERTS 注入|
|OBJECT_STORAGE_ENDPOINT|无默认；完整 HTTP(S) origin；正式强制 HTTPS|
|OBJECT_STORAGE_BUCKET|与 endpoint 成对提供；桶名以连字符加当前环境结尾；实际驱动尚待选型|
|SESSION_SECRET|开发/测试可缺失；提供时至少 32 字节，正式必须注入独立随机密钥；当前不签发会话|
|CONFIRM_EMPTY_ROLLBACK|仅本地空基础库回退时使用，值必须与 APP_ENV 一致|
|CONFIRM_DISPOSABLE_DATABASE|集成测试必须为 ai_games_test，仅对明确可丢弃的测试库设置|

生产模式缺任何关键配置会拒绝启动。三套环境分别建立独立数据库、账号、网络权限、桶和密钥，不能仅换 APP_ENV 复用资源。自动校验只能检查命名、配置和库内身份，无法证明供应商隔离或检测另一环境重用了同一密钥；上线前必须实测。正式凭据由秘密管理系统注入，禁止复制到测试。

## 迁移及回退

本机暂无 PostgreSQL，以下步骤是实例可用后的操作手册，尚未执行。使用私网或回环数据库；先由管理员创建专用数据库及账号。迁移账号有该库的 DDL 权限；应用账号仅有必要 SELECT/INSERT 权限，不使用管理员/超级用户运行应用。角色名都遵守环境后缀；通过分别注入 DATABASE_URL 使用迁移账号或应用账号。

配置好 `.env` 后，先读状态，再应用迁移，再读状态：

```powershell
npm run db:status
npm run db:migrate
npm run db:status
```

应用启动不隐式迁移。空库状态应为 []；当前 up 后为 [001_foundation, 002_security_audit]；重复 up 不重复建表。SQL 事务失败必须完整回退。首个迁移只建立 schema、环境身份和一般错误审计；阶段 2 追加安全审计迁移，见 docs/phase-2/development.md。

每次回退仅撤销最新一条迁移：002 删除空安全审计表；随后 001 删除空基础 schema，保留迁移账本表。对应表有审计记录则拒绝。真实执行前须核对绝对目标（数据库服务器、数据库名和环境）、做备份并获得删除操作确认。本轮未执行此操作。已确认仅为空开发库时：

```powershell
$env:CONFIRM_EMPTY_ROLLBACK = 'development'
npm run db:rollback
Remove-Item Env:\CONFIRM_EMPTY_ROLLBACK
```

真实测试必须使用全新、可丢弃的 `ai_games_test`。`.env.test` 配好 APP_ENV=test、真实 DATABASE_URL 与 CONFIRM_DISPOSABLE_DATABASE 后运行：

```powershell
npm run test:postgres
```

测试先检查不存在 platform schema，不清除已有数据。覆盖并发迁移、重复 up、空库 down、重新 up、审计落库、非空 down 拒绝和校验和篡改拒绝。最后保留测试审计及被篡改的账本作为证据，所以该测试库不能用于后续开发；再次运行须由管理员新建可丢弃实例，不能对正式库执行。CI 使用独立临时 PostgreSQL 18 服务，密码仅用于该临时合成环境，不是实际服务凭据。

## 应用版本回滚与人工验收

发布尚未发生，当前也没有上一版正式应用可供回滚。后续在独立测试目录保留两个已验证提交的发布产物和各自锁文件，先备份测试库；停止新版本，切换至上一版产物并 `npm ci --ignore-scripts`、启动、检查 live/ready、运行关键回归，再切回新版本。优先保留向前兼容 schema；不得为应用回滚自动执行 down。数据库与应用兼容性、数据保留和恢复时间均需记录。本轮只提供流程，未声称版本回滚演练通过。

人工验收清单：

1. 按本页启动，检查 live=200、无依赖 ready=503、未知路由统一 404，响应带随机 requestId。
2. 向查询参数/请求头放入合成敏感标记，确认 stdout 无标记、密码、连接串和原始异常。
3. 测试环境尝试配置 production 数据库/桶名称，确认启动拒绝；实际用独立账号验证不能访问另一环境。
4. 有实例后执行专用集成测试，记录 PostgreSQL 版本、输出与迁移/回退证据。
5. 供应商确定后实现和验证私有 ACL、跨桶拒绝、不可覆盖写入，完整依赖接通后 ready 才能返回 200。
6. 保留两个应用版本，在测试环境执行上述应用回滚演练。没有完成 4—6 前不宣称阶段 1 全部通过。
