# 生产部署、手动启停与备份恢复

2026-11-13。基准提交 e105609，应用版本 0.3.0。本文描述本次实现及执行边界；不表示正式安装、异盘灾备或公网验收已经完成。

## 当前约定

用户已明确取消 08:00—22:00 定时开关。仅由用户主动启动、主动安全停止；无时段限制、开机触发器、自动重启开放或计划任务。PostgreSQL 服务也使用 Manual 启动。停止后不会自动重新开放。原部署计划中的定时要求已被本约定取代。

沿用三个独立账号、认证命名管道、NTFS、WFP、Job 限制；未放宽原隔离边界。生产主站只使用 app_production；试玩和校验仍无数据库/会话凭据。恢复工具和控制器不运行在处理公网请求的账号下。

原 start-local.cmd 的 Local/Public 仍为开发及试运行入口。新增生产控制器不可通过把开发环境变量改成 production 来使用。

## 已实现入口

| 文件 | 用途 |
| --- | --- |
| scripts/production-database.mjs | 生成可审查迁移计划；单独初始化生产角色/数据库；按批准摘要向前迁移 |
| scripts/production-postgres.ps1 | 准备外部 TLS/hba 配置；注册手动启动的专用虚拟身份服务；按 ACL 日志回滚 |
| scripts/production-isolation.ps1 | 原隔离安装器；可复制批准 CA；监督器先请求主站排空再关闭 Job |
| scripts/production-services.ps1 | Plan、Start、Stop、Backup、Status、Run；无任何计划任务注册动作 |
| scripts/production-controller.mjs | 手动运行会话的健康检查、短期许可、入口关闭、排空、备份与停库 |
| scripts/production-backup.mjs | keys、backup、verify、restore；仅独立恢复目标 |
| scripts/production-retention.mjs | 生成保留/清理计划，批准摘要后只清理已有异盘验证副本的本地备份 |
| scripts/production-cutover.mjs | 受控数据库改名切换与反向回滚；不自动打开 Tunnel |

## 部署前收集和批准

实际参数必须由操作者填写并复核，不生成带占位符的运行配置。当前只确认沿用本机与现有域名，仍缺主站/试玩域名和另一物理磁盘目标。C:、D: 均在物理磁盘 0，不能作为彼此的异盘灾备。

非敏感控制 JSON 需要：projectRoot、installationRoot、backupRoot、stagingRoot、evidenceRoot、offDiskRoot、recoveryMaterialFile、pgBin、caFile、pwsh、maintenanceEnvironmentFile、databaseService、databaseDirectory、databaseControlRoot、scannerExe、scannerConfig、healthUrl、tunnelAdapter。所有路径采用实际绝对路径。healthUrl 只能指向隔离安装器的本机主站 readiness；tunnelAdapter 指向现有 start-local.ps1。databaseService 须为 AGP-PostgreSQL- 前缀的专用名称。

生产数据库准备另需 databasePort、serverCertificate、serverPrivateKey。保留 data/postgres 实例，不改写其内部数据或原配置；外部 postgresql.conf 引用原配置，再指定 loopback、独立 hba 和 TLS。外部 hba 先拒绝生产库明文连接，仅允许三个指定登录角色的 SCRAM/TLS，然后保留其他数据库原有认证规则。变更会影响该共享集群的启停，须先停止开发和其他写入者。

所有控制配置、维护环境文件、staging/evidence/备份目录及恢复密钥目录，须仅允许安装管理员、SYSTEM、Administrators。恢复材料不得置于作品树或备份包内，须另存一份离线受控恢复副本。准备新目录及 ACL、注册服务、修改现有数据库目录 ACL、生产数据库初始化/迁移、切换公网，都须按适用 AGENTS.md 获取具体授权后执行。

原受限 Tunnel 文件只由现有 start-local.ps1 消费。新增 -ManagedTunnelOnly 模式只启动其已有 Own Tunnel 分支，不启动开发库/应用。控制器不读取或打印这两个文件；执行此新生产流程前仍需明确批准其消费配置与公网操作。没有临时隧道回退。

## 数据库与 TLS

production-database 的 plan 输出目标主机、端口、固定库名、应用版本、所有迁移校验和及摘要，文件不含连接密码。initialize、migrate 读取同一计划并要求 APPROVED_RELEASE_SHA256 精确匹配。旧 db:migrate 仍拒绝 production，没有解除保护。

维护环境变量与主站 main.env 分开：

- PRODUCTION_ADMIN_URL：仅受控初始化、独立恢复建库和切换期间使用，控制器日常不需要。
- PRODUCTION_MIGRATION_URL：migrate_production；可显式 SET ROLE owner_production。owner 无 LOGIN，持有 schema；维护读取 pg_read_all_stats 以检查共享集群的其他客户端。
- PRODUCTION_BACKUP_URL：backup_production，只读表/序列，不处理公网请求。
- DATABASE_CA_FILE：批准 CA 文件。主站使用 -DatabaseCaFile 复制到自己的只读配置区。
- 主站只获得 DATABASE_URL、DATABASE_TLS=verify-full、DATABASE_CA_FILE、SESSION_SECRET 等业务配置；启动检查拒绝超级用户、建库/建角色、复制、绕过 RLS、数据库所有者和迁移表写权限。

初始化要求三个全新随机 256 位十六进制角色密码；已存在同名角色/数据库时拒绝覆盖。角色事务提交后建库失败会保留现场，不自动删除角色。迁移事务有锁及校验和检查；升级既有版本还要求 PRE_MIGRATION_BACKUP 与 RECOVERY_MATERIAL_FILE 指向已校验的当前 schema 备份，并要求所有应用连接和安装进程停止。

客户端验证证书链和主机名，不使用 rejectUnauthorized:false。pg_dump/pg_restore 显式设置 PGSSLMODE=verify-full 与 PGSSLROOTCERT；密码仅传子进程环境，不拼入命令行。CA 私钥不进入主站或备份包。证书续期需另行受控更新后验证；不能用测试两日有效证书部署生产。[PostgreSQL SSL 文档](https://www.postgresql.org/docs/18/libpq-ssl.html)

## 手动启停

操作命令的 ConfigFile 参数应指向已经批准、权限受控的实际配置。运行 Plan 不改变系统；Start 启动隐藏控制器，Run 是同等的前台入口，Stop 请求安全停止，Backup 执行离线一致性备份后保持关闭，Status 读取状态。

正式配置批准并安装后，在安装管理员的 PowerShell 7 中使用：

```powershell
$controlConfig = Read-Host '已批准的控制 JSON 完整路径'
.\scripts\production-services.ps1 -Action Plan -ConfigFile $controlConfig
.\scripts\production-services.ps1 -Action Start -ConfigFile $controlConfig
```

需要停止时执行 Stop，再查询 Status；Backup 会关闭运行中的业务并备份，或在已停止时单独备份，不自动重新开放：

```powershell
.\scripts\production-services.ps1 -Action Stop -ConfigFile $controlConfig
.\scripts\production-services.ps1 -Action Status -ConfigFile $controlConfig
# 需要显式备份时：
.\scripts\production-services.ps1 -Action Backup -ConfigFile $controlConfig
```

用户手动 Start 后：互斥文件锁拒绝重复控制器 → 保持入口关闭 → PostgreSQL 自身恢复 → schema、原件/sidecar、派生资源和发布引用核验 → 扫描器 → 原隔离监督器 → readiness → 12 秒短期许可 → 启动已批准 Tunnel。前次停止不完整时，先重新核验并完成备份才允许继续启动。失败不自动重试开放。

运行期间主站每个业务请求及试玩每次授权重新读取短期许可；后台清理同样受控。许可可在任何小时续期，22:00 不触发停止。控制器退出、休眠恢复导致许可失效、时钟回退或依赖失败时保持关闭，需要用户再次手动启动并经过恢复核验。

Stop/运行中的 Backup：先关闭公网入口及许可 → 拒绝新业务请求 → 等待已接受的 HTTP 异步处理和后台任务 → 关闭主站数据库池 → 停止剩余校验/试玩 Job → 验证无安装进程 → 备份 → 正常停库。10 秒后可断开 HTTP socket，但仍等待 handler；主站 130 秒上限、监督器 135 秒上限后可安全中止进程，必须报告 forcedAbort。未提交数据库事务由 PostgreSQL 回滚；孤立文件保留且不自动公开。内存分块与未完成上传不能恢复，客户端需重新上传。

无运行中的控制器时，Backup 仅启动依赖、检查并备份、再停库，不创建公网入口。不会自动重新启动业务。未授权实现任何周期备份。

状态单独记录 ingressClosed、writersStopped、writerOutcome、backupVerified、databaseStopped。备份失败不跳过安全停库；写入者未停不得执行备份或停库。共享集群存在其他数据库客户端时拒绝停库，不擅自终止开发会话。只有 writersStopped/databaseStopped 确认后才可安全关闭电脑；backupVerified=false 仍意味着灾备未完成。此工具不执行 Windows 自动关机。

## 一致性、加密与异盘

备份在进程停止后持有业务表 SHARE 锁，使用导出快照给独立只读 pg_dump；记录全部表行数与排序行摘要，核验数据库版本、全部迁移、原件、资料附件及派生文件的引用。作品树只取 private 和 serving，不包含角色凭据/通道密钥。inbox/stage 不是可恢复上传会话；孤立资源不会获得发布引用。

每个文件独立流式 AES-256-GCM，加密关联数据绑定相对路径，记录大小/SHA-256、密文摘要、IV/认证标签。清单自身加密认证；验证所有密文和解密后摘要、重新检查来源，flush 后才写 complete.json。任何中断、缺失、多余文件、链接、路径逃逸、密文破坏或不匹配密钥均拒绝恢复。恢复始终重新验证整个包，不只相信 complete 标记。

keys 仅在已经保护的独立目录创建随机加密密钥与原 SESSION_SECRET 恢复材料，禁止打印密钥。包只含 keyId。pg_dump 的明文工作副本保留在受控 staging；失败现场和演练恢复目录也含隐私，不能当作已加密灾备或复制到普通共享目录。清理这些现场需单独核对和批准，不能随意删除。

本地成功后才复制到 offDiskRoot，再核验全部密文字节、认证及摘要。Get-Partition/Get-Disk 必须证明来源与目标不属于同一物理磁盘；无法证明、虚拟盘、存储空间或断开的目标均不算成功。异盘失败时仍报告本地副本状态与安全停库状态，不能宣称灾备完成。

初始保留策略可采用每日 7、每周 4、每月 3，但应由操作者按容量确认。retention plan 验证所有包和异盘副本；不完整包导致清理拒绝。apply 要求当前计划未变及 APPROVED_RETENTION_SHA256。仅删除明确候选的本地目录，保留最新和各周期份数；每个删除对象均有已核验异盘恢复副本，脚本不删除远端最后副本。恢复方法是将对应异盘包复制回新本地目录后完整 verify。

## 独立恢复与删除语义

restore 只接受全新 ai_games_restore_ 加 16 位随机十六进制库名和新目录，拒绝覆盖现有库/目录。先验证包、应用版本、全部迁移校验和及 PostgreSQL 主版本；随后创建独立库、一次事务 pg_restore、逐表摘要和文件引用比较。无论失败或成功，都不自动切换或开放。

迁移 012 新增不随普通审计过期的 recovery_ledger，记录已完成账号删除、会话内容删除、作品删除、版本撤销/撤回和运维隐藏。应用可读，不可直接改写账本；固定 search_path 的触发器记录。恢复可叠加较新的权威账本，调用既有业务删除参与者处理匿名化与关联记录，保留/补充供应商删除队列。撤回/隐藏采取保守禁止重新公开策略，重新开放需人工复核。

**旧备份不能证明备份之后发生的删除不存在。** 源库仍可访问时应导出其最新账本；源库丢失时需使用最后可验证账本并人工核对无法覆盖的时间段。缺少这一步，restore-report 的 eligibleForCutover 保持 false，不能以“备份哈希正确”代替删除核对。

恢复使用单独保存的原密钥解开 MFA，再用新的 RESTORE_SESSION_SECRET 重加密，保留 TOTP 防重放步数。清空所有会话、身份令牌（含旧恢复码/重置/取消/复核凭据）和 MFA 待启用状态；保留账号密码摘要。旧恢复码不能继续使用，用户需重新获取恢复材料。AI key 重加密但默认禁用，避免演练触发第三方请求。供应商删除账本不清空。历史 play_sessions 是统计数据，内存试玩票据和分块上传不会跨进程恢复。

切换前要求：新账号/目录 ACL、独立恢复的登录/MFA、审核/试玩/撤销验证，以及最新删除账本核对证据。production-cutover 的批准计划固定证据文件 SHA-256；停止两个安装的入口/写入者、关闭所有源/目标客户端后，事务改名保留旧 ai_games_rollback_* 与新生产库。随后人工选择对应已验证安装配置，再手动 Start。rollback 反向改名，保留切换后产生的数据；回滚后仍需评估这些新写入，不能静默丢弃。数据库切换不自动复制私有文件或覆写配置，也不自动开启公网。

## 已验证与尚待验证

自动回归包括手动夜间启动、跨原 22:00 边界持续运行、过期许可、重复停止、依赖故障、休眠/时钟异常、备份故障与停库独立报告、错误密钥、损坏/不完整包、独立目录恢复、保留策略和真实 Windows Job 进程清理。

真实集成在新建 tmp/production-recovery-* 集群执行：PostgreSQL 18.6 TLS、错误证书/主机名拒绝、最小角色权限、可重复迁移、真实 ClamAV、HTTP 上传/扫描/审核/试玩、AES 备份、独立恢复、密码和 MFA、旧凭据失效、恢复后 HTTP 试玩与撤销、更新删除账本覆盖，以及数据库切换/回滚。应用 ACL 在该集成中为注入探针；不能冒充正式服务身份或原隔离系统验收。

证据：tmp/production-recovery-eab78721-b0e2-491d-a5fd-2b821e8312c8/evidence.json。此轮 passed=true，cutoverRollback/laterDeletionOverlay=true，最终 databaseStopped=true；独立恢复阶段 1640 ms，更早三轮亦通过。端口 55680/3311 已核对无监听。以最终交接记录中的新一轮证据为准。

2026-11-13 用户批准一次性服务验收后，真实 PostgreSQL 虚拟身份服务已通过完整链路：`tmp/production-recovery-d1e5c8fe-de9d-4e92-a697-ba99d80e8c17/evidence.json` 的 passed、windowsService、tlsAndRoles、cutoverRollback、laterDeletionOverlay、databaseStopped、serviceRemoved 均为 true。此次恢复阶段 877 ms；外层 `tmp/service-acceptance-20261113-run5-status.json` 为 passed=true/serviceRemaining=false。55680/3311 已核对无监听。两个失败初始目录和第四轮现场也已完成剩余 ACL 回滚，保留保护文件供核查。

系统验证发现并修复：虚拟账号必须向 [CreateServiceW](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew) 传 NULL 密码，使用 sc.exe 的无 password 参数注册；HBA include 使用双引号路径；ACL 回滚允许 PostgreSQL 自行回收旧 WAL/关系文件，不重建这些文件，同时移除新文件的服务权限并验证无残留 SID。

更新后的专用应用账号监督器、完整手动控制器/公网启停、正式 TLS/ACL、异盘复制和整机重启恢复，仍需在相应环境实际验收。当前通过的是实际 PostgreSQL 服务，应用部分仍为同用户和注入 ACL 探针，不代表整套正式系统验收。scripts/run-production-service-acceptance.ps1 默认 Plan；Run 仅创建新 tmp 集群及 AGP-PostgreSQL-Acceptance 虚拟身份服务，最终正常停库、卸载同一服务并恢复测试 ACL。不能重复使用上次未清理的服务。

不承诺固定 RPO/RTO。取消定时停止后，数据损失窗口等于故障发生时距最近成功备份快照的时间，可能超过一天；长时间运行期间若需更短窗口，应另行讨论显式离线备份频率或其他方案。演练耗时仅代表少量合成数据，不含正式备份传输、人工核对、Windows 安装和公网切换时间。
