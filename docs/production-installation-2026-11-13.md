# 本机正式安装记录（2026-11-13）

**2026-11-15 当前状态：D 盘正式安装与本机功能验收完成。公网完整业务、真实账号隔离、手动 Stop/Backup/Start、本地备份与独立恢复核验均已通过。Windows 许可文件共享冲突已复现修复，重启后连续 90 次健康检查通过。01:59（上海）实查服务 active、公网健康 200。用户已自行释放空间，本任务未执行清理清单中的任何删除，也未创建 C 盘生产目录。**

运行状态必须以 `data/production/evidence/controller-state.json` 和公网健康检查为准；启动命令返回 PID 不代表已经开放。不要重复运行 Install。异盘灾备仍未验证，用户已接受本地备份策略。

## 已确认的决定与现场

- 用户选择全新空生产库，保留开发数据，不迁入账号或作品。
- 用户没有第二块物理磁盘，并要求继续；记录为接受暂缺异盘备份，不记录为异盘灾备实测通过。停机仍必须成功完成本地加密备份。
- 用户删除其他 mod 后，安装前 D 盘实测空闲 35.08 GiB。最终目录为 `D:\AI-project\Codex-project1\data\production`；C/D 仍同属磁盘 0，没有异盘副本。
- 已从原验收文档确认主站 `https://wsyz-aigames.de5.net`、试玩 `https://wsyz-play.us.ci`。公网切换时由既有启动器核对实际配置；两个受限 Tunnel 文件没有直接读取、输出或修改。
- 起始仓库 `main@1ecb086` 干净，版本 0.3.0；4320/4321/55440/55441/3310 无监听，没有相关生产服务和遗留应用账号。执行前再次检查。

## 可审查执行入口

在项目目录执行只读计划：

```powershell
.\scripts\install-production.ps1 -Action Plan
```

下列是首次安装命令，现已执行完成，不得再次覆盖已有安装：

```powershell
.\scripts\install-production.ps1 -Action Install -AcceptLocalBackupOnly -ConfirmInstallation
```

脚本拒绝复用任何已有目标根目录、同名服务/账号和占用端口。失败保留受保护现场，不能重新运行覆盖；先检查 `evidence\installation-failure*.json` 与 `install-tools.log`，再制定针对性恢复步骤。配置不含虚构异盘路径。

| 实际目标 | 用途 |
| --- | --- |
| `D:\AI-project\Codex-project1\data\production\postgres` | 全新独立 PostgreSQL 集群，55441，生产库 `ai_games_production` |
| `D:\AI-project\Codex-project1\data\production\postgres-control` | 外部 TLS/HBA、专用 PostgreSQL 程序与 ACL 日志 |
| `D:\AI-project\Codex-project1\data\production\runtime` | 隔离运行程序、作品和三个账号的配置 |
| `D:\AI-project\Codex-project1\data\production\configuration` | 控制配置、分离的维护/初始化/主站凭据、迁移批准摘要 |
| `D:\AI-project\Codex-project1\data\production\certificates` | 专用数据库 CA 与服务器证书；客户端显式信任 CA，不更改系统根证书 |
| `D:\AI-project\Codex-project1\data\production\recovery` | 加密恢复材料与首次管理员密码，仅安装用户、管理员与 SYSTEM 可读 |
| `D:\AI-project\Codex-project1\data\production\backups` | AES-GCM 加密本地备份，仍在同一物理磁盘 |
| `D:\AI-project\Codex-project1\data\production\staging` | 受保护的明文备份工作副本，不当作加密灾备 |
| `D:\AI-project\Codex-project1\data\production\scanner` | 独立 ClamAV 程序和病毒库副本，3310 |
| `D:\AI-project\Codex-project1\data\production\evidence` | 安装、备份、启停与故障证据 |

Windows 服务为 `AGP-PostgreSQL-Production`，虚拟服务身份，只能手动启动。三个新非管理员账号为 `agp1164b01452m`、`agp1164b01452g`、`agp1164b01452v`。六条 WFP 规则仅针对新运行目录中的两个工作进程程序。Job 限制沿用现有实现。只修改新安装树权限，不修改开发主库、原作品或卷根 ACL。

数据库角色密码、会话密钥、服务密钥均重新随机生成。首个管理员登录标识为 `admin@wsyz-aigames.de5.net`；这是账号标识，不代表此邮箱可收信。随机密码在受保护的 `recovery\first-administrator.json`。已通过正式网页完成 MFA 设置，并实测仅密码被拒绝、正确动态码登录成功。验证器密钥在 `recovery\mfa-enrollment.json`，一次性恢复码在 `recovery\mfa-recovery.txt`；管理员在本机将密钥导入自己的验证器应用，不把这些内容发到聊天或提交 Git。临时浏览器凭据配置已移除，验收浏览器已关闭。既有演示账号密码不复制。

服务器证书到期时间为 2027-12-15 23:29:53（上海），SAN 为 localhost 和 127.0.0.1；需到期前受控续期。2026-11-14 已更新官方 ClamAV 病毒库，并通过实际 clean/EICAR 扫描。运维脚本仍由 `D:\AI-project\Codex-project1\scripts` 提供；保留该仓库、Node 和 PowerShell，不把 `tmp` 中的下载源误认为安装后的数据库运行程序。

## 初始备份、手动入口和回滚

本次没有既有生产环境可备份，也不对开发库执行任何数据库操作。安装计划先保存在受保护证据目录；初始化与迁移后，在公开开放前完成首份加密一致性备份及完整验证，然后正常停库。此初始备份作为新生产库的开放前恢复点。安装入口自身不打开 Tunnel、不创建计划任务、不按时间启停。

安装已生成 `D:\AI-project\Codex-project1\data\production\Start.ps1`、`Stop.ps1`、`Backup.ps1`、`Status.ps1`，须由同一安装用户在管理员 PowerShell 执行（隔离账号凭据使用其 DPAPI）。`Backup` 会停止正在运行的业务，备份后保持关闭。`Stop` 请求排空后查询 `Status`，等 `writersStopped`、`databaseStopped`、`localBackupVerified` 确认，不能仅凭请求提交成功关机。

本地模式显式配置 `backupPolicy=local-only` 和 `localOnlyAcknowledged=true`，不设置 `offDiskRoot`。`backupVerified` 表示已满足所选备份策略；另报 `localBackupVerified`、`offDiskVerified`、`disasterRecoveryVerified`，后两项保持 false。缺省策略仍要求异盘，不因磁盘不可用自动降级。原 `DifferentDisk` 检查和需要异盘副本的备份清理规则均不放宽。本地副本和恢复密钥同时丢失仍不能恢复整盘故障。

回滚顺序：

1. 如已开启，执行 `Stop.ps1` 并等待入口关闭、写入者停止、备份及正常停库；不得结束其他业务进程。
2. 使用实际 `configuration\controller.json` 对 `production-postgres.ps1 -Action Unregister`，只注销本次已停止服务并恢复记录的 ACL。
3. 对实际 `runtime` 执行 `production-isolation.ps1 -Action Uninstall`，只移除记录的 WFP 与三个新账号。
4. 保留全部生产数据、备份、配置和证据；不删除或覆盖开发数据。账号原 SID 删除后无法重建，重新安装使用新的已审查方案，不能直接复用旧 SID 权限。

卸载属于单独确认的系统操作，安装失败不会自动删除账号或数据。上线后回滚前应保留最新业务写入，不能只恢复初始空库造成静默丢失。

## 正式环境验收结果与边界

最终回归：`npm run check` 147 模块语法检查通过；`npm test` 106 项中 104 通过、2 项真实 ACL 单测按默认配置跳过；`npm run check:baseline` 130 需求/18 决策通过；全部 PowerShell 解析和 `git diff --check` 通过。实际安装身份的 ACL/WFP 验收另外执行并通过，不能把默认单测跳过写成真实检查通过。许可共享冲突修复包含真实 Windows 并发、短暂占用恢复、持续占用限时失败测试。

- 公网浏览器：真实管理员密码与 MFA 登录；新建合成作品、上传 ZIP、ClamAV 扫描、隔离预览、领取审核并通过。匿名审核前试玩 404，通过后详情/试玩/资源 200；桌面和 390×844 视口点击计数从 0 到 1、2。试玩来源为 `https://wsyz-play.us.ci`，iframe sandbox=`allow-scripts`。
- 合成作品 `aec87e99-6243-43e3-b0e9-c9ed3c6ec173` 已经正常二次验证后撤销，详情、试玩、撤销前取得的资源链接均为 404。保留测试记录供审计，不将其作为公开作品。
- PostgreSQL 实际 TLS、错误主机名/不可信 CA 拒绝、app_production 无超级用户/建库/建角色/复制/绕过 RLS 权限以及系统身份、迁移记录、恢复账本写入权限隔离通过；未向开发库执行测试。
- 真实三个 Windows 账号拒绝数据库文件、维护凭据、恢复密钥；game 仅可读 serving；validator 仅可读 inbox、读写 stage，出站仅允许扫描器；授权管道拒绝通过。256 MiB 内存超额分配被拒绝，1% CPU Job 测试实测约 0.90%，主站 5 次响应均 200、11–13 ms。
- 手动 Stop 后正常排空、备份并释放四个监听；停机状态下 Backup 生成新备份且保持关闭；再次 Start 成功连接固定 Tunnel。没有定时任务、开机自动开放或定点关机。
- 使用实际安装备份在 D 盘新建独立 55442 恢复集群，逐表摘要与文件引用核验通过，MFA 重加密后真实身份服务登录通过，旧会话/令牌清除、撤销状态保留。恢复集群已正常停止，正式源库没有被恢复操作改动，没有执行切换。

异盘与离线恢复材料备份未执行，`offDiskVerified/disasterRecoveryVerified=false`。本机小数据恢复步骤用时 1216 ms，不代表正式 RTO；损失窗口由最后一次成功手动备份决定。整机重启、容量与长期稳定性不由短时功能验收替代。正式库从空库建立，目前含首管理员和已撤销的合成验收记录，开发数据仍保留在原位置。

## 最新证据与操作

- `evidence/installation-acceptance-1794679157044.json`：正式安装功能验收汇总，当前 active/公网200、已撤销作品404、C盘生产目录不存在；异盘和长期可用性仍分别标 false。
- `evidence/runtime-observation-1794679132520.json`：修复后重启，193145 ms 内连续 90 次本机 readiness 均成功，最大946 ms；同时每15次采样检查一次公网健康，均为200。这是短时回归，不代表长期可用性保证。
- `evidence/manual-cycle-63ca403b233048b5887a7f36ab3ab688.json`：Stop、Backup、重启全部通过。
- `evidence/isolation-acceptance-8cfde82d029440e195b81b45ddb85852.json` 与同 ID 的 `resource-acceptance-*.json`：真实账号和资源限制通过。该次由 Windows PowerShell 5.1 执行；已加 `-UseBasicParsing` 避免不必要的网页解析确认，并修正其 Get-Content 字符串附带元数据导致报告膨胀的问题。
- `evidence/runtime-acceptance-*.json`、`public-approved-*.json`、`public-revoked-*.json`：TLS/权限/扫描与公网发布撤销证据。
- `evidence/installed-restore-1794661089254.json`：实际备份 `2026-11-14T12-57-21-844Z-91cf56f9-7264-4890-b403-f2ce6b6f9409` 恢复核验通过；恢复现场保留在 `restore-checks/579699c5-cb66-47b6-9676-8d8a3223bf32`。
- 桌面与手机截图：`preview/production-installation-20261114/`，均为合成游戏画面，不含认证信息。
- 2026-11-14 21:27:58（上海）曾再次安全停机，最后 readiness=200、三个受管进程存活。2026-11-15 在一次性文件上复现 Get-Content 与原子 rename 的共享冲突（第 122 次 EPERM），已改为共享删除的短时读取、1 秒内限时原子重试，并记录续写失败的安全错误代码。持续写入失败仍关闭，不延长运行许可有效期。

日常在同一安装用户的管理员 PowerShell 窗口执行下列入口，按需选择一条：

```powershell
& 'D:\AI-project\Codex-project1\data\production\Start.ps1'
& 'D:\AI-project\Codex-project1\data\production\Status.ps1'
& 'D:\AI-project\Codex-project1\data\production\Stop.ps1'
& 'D:\AI-project\Codex-project1\data\production\Backup.ps1'
```

工具侧提权曾被自动审批以 `blocked by policy` 拒绝；实际高权限入口由用户在本机执行，未绕过该限制。两种专项复验入口为 `scripts/verify-production-isolation.ps1` 和 `scripts/verify-production-manual-cycle.ps1`；后者会短暂关闭公网并重启，只在主动验收时手动运行。

## 早期安装与故障排查记录（历史）

- `tmp/production-install-resume-20261113-status.json`：passed=true；`data/production/evidence/installation-result.json`：installed/closed/localBackupVerified=true，offDiskVerified/publicAcceptance=false。
- 初始备份：`data/production/backups/2026-11-13T15-31-56-054Z-5ec85a5a-8426-462f-9fce-d07b48bfe506`。后续失败启动也生成独立验证备份，没有覆盖初始恢复点。
- 2026-11-14 12:28:59（上海）证据 `data/production/evidence/b2a6faf2-a551-403e-a3b0-e33d301994a9.shutdown.json`：reason=dependency-failed，ingressClosed/writersStopped/backupVerified/databaseStopped=true，graceful=true、forcedAbort=false。服务实查 Stopped/Manual，4320/4321/55441/3310 无监听。
- 修复 initdb 降权令牌无法读取管理员组专属密码文件：新安装树另授安装用户明确权限。运行账号解析新受保护父目录时，仅授父目录本身 ReadAndExecute、不继承到备份/密钥子树；原父 ACL 另存 evidence/parent-acl-before-runtime-traverse.bak。
- 主站曾早于 ClamAV 病毒库加载完成而退出；控制器已增加真实扫描就绪等待。修复后业务进程通过 readiness，但 Tunnel 子进程随后失败，触发安全关闭，不能据此声称公网连通。
- 已增加既有启动器 ManagedStatusFile 与控制器等待 connected 的握手，未实际复验；记录不保存 Tunnel 配置或 Token。受限文件仅由获准的既有启动器消费。
- 后续“提权启动正式服务并打开验收页面”的工具命令被自动审批拒绝，原因仅为 blocked by policy。未绕过；已请求用户在管理员 PowerShell 7 运行 D 盘的 Start.ps1，再继续检查新 *.tunnel.json 和 controller-state.json。
- `scripts/verify-production-isolation.ps1` 已准备实际账号只读句柄、WFP 和管道拒绝探针，尚未执行；不读取凭据内容或修改数据库文件，结果写入受保护 evidence。
- 用户手动启动后，新隧道状态明确报错找不到 cloudflared；本机工具实际存在，复现实验证明净化环境缺少 PATHEXT 时省略扩展名查找失败。既有启动器已改为明确查找 cloudflared.exe，不安装新软件、不读取受限配置。
- 安全停库后控制器锁曾延迟释放约 140 秒：Promise.race 中未清除排空超时计时器。已改为退出后清除计时器和监听器，两项专项测试验证进程及时退出及超时清理；不强杀旧控制器，待其自然释放锁。
