# 项目目录与本地运行手册

2026-11-13：生产新增受控部署、手动启停及独立加密恢复，见 [生产部署与恢复](production-deployment-recovery.md)。原 data/postgres 不搬迁/覆盖；运行私有作品与派生资源置于新隔离安装的 private/serving，生产备份包在批准备份目录，恢复密钥单独受控保存，不与备份包混放。本文后续 local:backup/local:restore 为开发流程，不能用于生产。无定时开关或开机自动开放。

2026-11-03：保留 Node.js 原生 HTTP、原生前端与 PostgreSQL。根目录仍为 `D:\AI-project\Codex-project1`。按最新确认，新主库位于 data/postgres，旧库及旧作品未导入、未修改。

## 目录标准

```text
frontend/                 原 src/web，页面、样式、浏览器模块
backend/src/              服务入口、配置、modules 业务、platform 基础设施
database/migrations/      原 001—010 迁移，编号和 SQL 内容不变
data/postgres/            固定数据库集群，仅 PostgreSQL 工具管理内部文件
data/submissions/         私有作品，按 development/test 环境隔离
  development/incoming/  坚果云待导入副本和清单
  development/quarantine/待检查或失败材料
  development/review/    待审核 ZIP、截图、简介和资料原件
  development/release/   已批准 ZIP，由受控试玩接口访问
data/backups/             dump、作品副本、摘要清单、恢复密钥
data/exports/             后台导出的服务器私有副本
docs/                     项目与运行文档
scripts/                  启停、迁移、备份、导入、检查工具
tests/                    单元、HTTP、数据库集成测试
prototypes/               保留原型
tmp/、preview/            临时测试和预览，不作为主库目录
.env                      本机真实配置，禁止入库
.env.example              无凭据示例
package.json、package-lock.json  保持一套依赖
README.md、HANDOFF.md、项目计划书  保留
```

历史阶段文档的旧目录是历史记录，当前操作以本文为准。所有参赛者、团队、作品、版本、审核、互动、有效试玩、评委评分、排行仍由 PostgreSQL 管理。来源和文件键记录在既有 upload_events；不引入 JSON 业务数据库。简介和封面保留数据库展示投影，同时保存本地原件；网站资料编辑也写入原件及关联事件。

## 启动与持久化

双击 `start-local.cmd` 后选择 `1` 本地启动或 `2` 公网模式。也可执行 `start-local.cmd -Mode Local` 或 `start-local.cmd -Mode Public` 跳过选择。`-CheckOnly` 不建立隧道。

公网模式需要 PATH 中已有 `cloudflared`；缺失时提示安装命令并退出，不自动安装。启动时建立两个 Cloudflare Quick Tunnel，分别连接主站与隔离试玩监听地址；等待连接注册后显示临时 HTTPS 地址。免费地址可能每次变化，仅用于公网测试，不代表生产验收通过。隧道失败或超时会提示 `tmp/public-tunnels/` 下日志路径，并关闭本次创建的隧道。Ctrl+C 退出时也清理隧道；电脑必须保持联网和运行。公网模式使用当前本地数据，分享前确认内容适合公开。

启动入口优先使用 PowerShell 7；未安装时自动使用 Windows PowerShell 5.1。`start-local.ps1` 保持 UTF-8 BOM 编码，以便 Windows PowerShell 正确读取中文。

正常启动后等待网站就绪，自动在默认浏览器打开发现页；`-CheckOnly` 不打开浏览器。等待最多 60 秒，超时可使用终端显示的网址手动访问。

日常可直接双击项目根目录的 `start-local.cmd`：检查依赖和端口、启动 data/postgres 新主库、检查迁移、复用或启动 ClamAV，最后启动网站。不会自动重建数据库或初始化旧内置账号。Ctrl+C 停止网站及本次启动的扫描器，新主库保持运行。`start-local.cmd -CheckOnly` 只检查，不启动服务。

已实测一键启动、扫描器 PONG、就绪检查和 discover/account/studio 返回 200。旧工作树中的 start-local.cmd 已删除，备份为 `tmp/phase-6-main-merge/start-local.cmd.20261103-082837.bak`；如需恢复，复制备份回原文件名。旧 start-local.ps1 和数据库未修改。

在项目根目录执行：

```powershell
npm run local:start
npm run db:status
npm start
```

网站 `http://127.0.0.1:4320`，隔离试玩源 `http://127.0.0.2:4321`，新数据库端口 55440。真实上传/导入需要 ClamAV 在本机 3310 可用，扫描不可用不会放行审核。

本机已完成初始化；不要重跑 local:init。首次安装才用 `npm run local:init`，遇到已有配置或集群会拒绝重建。Ctrl+C 停网站，`npm run local:stop` 停新库。未安装开机自动启动，重启后执行上述命令复用同一目录。

新克隆按 [首次安装指南](first-run.md) 运行 `setup-local.cmd`，工具路径保存于私有的 `data/local-tools.json`。数据库工具优先使用进程环境变量 `PG_BIN`，其次使用保存的路径；未配置时保留旧 `tmp/phase2-postgres/runtime/pgsql/bin` 兼容，最后尝试 PATH。ClamAV 使用 `CLAMAV_BIN` 或保存的路径，新安装病毒库与日志写入 `data/clamav/`；未配置的新旧入口仍保留原临时目录兼容。跨机器重新指定工具位置，已有数据库必须匹配 PostgreSQL 主版本。旧 local-identity-* 脚本保留供历史测试，不作为新主库入口。初始化异常时保留现场，不自动擦除或重新初始化。

## 坚果云收集与导入

保留坚果云入口：下载/同步到独立收集目录，再复制材料到 data/submissions/development/incoming。本次不启用 WebDAV 或后台自动同步。

本地 JSON 清单字段：sourceId（作品内唯一收集编号）、workId（已有作品 UUID）、zip（相对 incoming 路径）、metadata（licensed、orientation、saveVersion、domains）、profile（title、summary、instructions、category、tags）、screenshots（file 和 type 数组，type 为 png/jpeg/webp）。简介原文放在 profile.summary，导入时另存原件；截图最多 8 张，每张最多 500000 字节。ZIP 沿用现有上传限制。文件必须位于 incoming，拒绝路径和链接逃逸。

先通过网站创建作品并登录。使用作品所有者的 session cookie，由标准输入传递，不写入命令行或文件：

```powershell
$manifest = Read-Host 'incoming 内的清单相对路径'
$session = Read-Host '作品所有者的 session cookie 值' -AsSecureString
try {
  [System.Net.NetworkCredential]::new('', $session).Password |
    node --env-file=.env scripts\import-collection.mjs $manifest
} finally { $session = $null }
```

管理员不能绕过既有归属替他人提交。相同来源及内容重试返回原版本；同一来源内容改变被拒绝。新版本遵循既有撤回规则。ZIP 复用扫描和审核流程；附件扫描失败回滚数据库关联，隔离文件保留排查。导入不覆盖已有展示资料；后续通过资料页编辑。附件保存在私有审核区，未新增截图浏览界面。

## 备份与恢复

先停止网站和导入工具，确保无写入者：

```powershell
npm run local:backup
$backup = Read-Host '上一步输出的备份目录完整路径'
node scripts\local-runtime.mjs restore-check $backup
```

备份包含 pg_dump 自定义格式、作品副本、逐文件 SHA-256、各表记录数和行摘要，写清单前核对数据库未变化。演练创建独立 ai_games_restore_* 数据库并逐表核对，不更改主库，保留验证库。持续写入时不能把数据库与文件的两个快照视为一致备份。

`npm run local:restore -- $backup` 仅允许空主库，拒绝覆盖已有表。验证文件后恢复数据库、作品和原 sessionSecret（旧 MFA 密文依赖该密钥），修改配置前生成 .bak。数据库与文件系统不构成一个原子事务；中途失败应检查现场并在新的空目标恢复，不能强制覆盖重试。没有执行覆盖现有主库的恢复。

备份不含集群全部角色：工具使用预建 app_development 并忽略来源 owner/ACL，云端需重建最小权限账户。备份含隐私和密钥，不能上传 GitHub。同盘备份不能防磁盘损坏，异盘副本位置仍需另行确定。

## 权限与迁移

生产隔离新增的部署目录和派生资源权限见 [production-isolation.md](production-isolation.md)。源码仍在 backend/frontend；验收产物只在 tmp/preview，生产新安装可选择 data/submissions 下的全新独立目录。已有原件与数据库不自动迁移或重建。

初始化收紧 Windows data 与 .env ACL，仅当前运行账户、SYSTEM 和管理员可访问。业务数据库角色不是超级用户。开发进程同属登录用户；云端应拆分数据库和网站运行账户。禁止手动编辑数据库内部文件，禁止把 postgres 目录加入坚果云同步。

整个 data、环境文件、凭据、备份、临时文件被 Git 忽略；只有 .env.example 可入库，目录由工具创建。SUBMISSIONS_ROOT、EXPORTS_ROOT 可配置，业务记录只存相对对象键。跨平台用逻辑备份和作品校验传输，不复制 Windows 数据库内部文件。生产环境原对象存储、域名与权限约束保持，本次不代表已可部署生产。

源码备份位于 tmp/architecture-backup-20261103-015624，可按目录映射恢复；恢复前另存当前改动。旧库和旧作品保持原路径，避免向新旧两套库同时录入业务。

## 验证与边界

45 项单元/HTTP 测试、130 条需求基线、真实 PostgreSQL 回归通过；收集导入包含归属、重复、落盘和扫描失败回滚。扫描用测试替身，真实 ClamAV 新链路未验收。新主库备份已恢复到独立库，表数和行摘要一致；实例停止/启动后摘要一致，未执行整机重启。页面视觉未改动，HTTP 测试覆盖资源路径，本次未重做完整浏览器视觉验收。
