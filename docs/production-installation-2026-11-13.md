# 本机正式安装记录（2026-11-13）

当前状态：安装入口已准备，尚未执行正式安装。不得将下列目标当作已安装事实。

## 已确认的决定与现场

- 用户选择全新空生产库，保留开发数据，不迁入账号或作品。
- 用户没有第二块物理磁盘，并要求继续；记录为接受暂缺异盘备份，不记录为异盘灾备实测通过。停机仍必须成功完成本地加密备份。
- 当前 C/D 都属于磁盘 0；检查时 C 剩余约 42 GiB，D 仅约 0.94 GiB。因此使用 `C:\ProgramData\AIGamesProduction`，不在 D 的旧数据树安装或创建目录链接。
- 已从原验收文档确认主站 `https://wsyz-aigames.de5.net`、试玩 `https://wsyz-play.us.ci`。公网切换时由既有启动器核对实际配置；两个受限 Tunnel 文件没有直接读取、输出或修改。
- 起始仓库 `main@1ecb086` 干净，版本 0.3.0；4320/4321/55440/55441/3310 无监听，没有相关生产服务和遗留应用账号。执行前再次检查。

## 可审查执行入口

在项目目录执行只读计划：

```powershell
.\scripts\install-production.ps1 -Action Plan
```

正式环境授权后，在当前安装用户的管理员 PowerShell 7 执行：

```powershell
.\scripts\install-production.ps1 -Action Install -AcceptLocalBackupOnly -ConfirmInstallation
```

脚本拒绝复用任何已有目标根目录、同名服务/账号和占用端口。失败保留受保护现场，不能重新运行覆盖；先检查 `evidence\installation-failure.json` 与 `install-tools.log`，再制定针对性恢复步骤。配置不含虚构异盘路径。

| 实际目标 | 用途 |
| --- | --- |
| `C:\ProgramData\AIGamesProduction\postgres` | 全新独立 PostgreSQL 集群，55441，生产库 `ai_games_production` |
| `C:\ProgramData\AIGamesProduction\postgres-control` | 外部 TLS/HBA、专用 PostgreSQL 程序与 ACL 日志 |
| `C:\ProgramData\AIGamesProduction\runtime` | 隔离运行程序、作品和三个账号的配置 |
| `C:\ProgramData\AIGamesProduction\configuration` | 控制配置、分离的维护/初始化/主站凭据、迁移批准摘要 |
| `C:\ProgramData\AIGamesProduction\certificates` | 专用数据库 CA 与服务器证书；客户端显式信任 CA，不更改系统根证书 |
| `C:\ProgramData\AIGamesProduction\recovery` | 加密恢复材料与首次管理员密码，仅管理员可读 |
| `C:\ProgramData\AIGamesProduction\backups` | AES-GCM 加密本地备份，仍在同一物理磁盘 |
| `C:\ProgramData\AIGamesProduction\staging` | 受保护的明文备份工作副本，不当作加密灾备 |
| `C:\ProgramData\AIGamesProduction\scanner` | 独立 ClamAV 程序和病毒库副本，3310 |
| `C:\ProgramData\AIGamesProduction\evidence` | 安装、备份、启停与故障证据 |

Windows 服务为 `AGP-PostgreSQL-Production`，虚拟服务身份，只能手动启动。三个新非管理员账号为 `agpf73561f641m`、`agpf73561f641g`、`agpf73561f641v`。六条 WFP 规则仅针对新运行目录中的两个工作进程程序。Job 限制沿用现有实现。只修改新安装树权限，不修改开发主库、原作品或卷根 ACL。

数据库角色密码、会话密钥、服务密钥均重新随机生成。首个管理员登录标识为 `admin@wsyz-aigames.de5.net`；这是账号标识，不代表此邮箱可收信。随机密码只写入受保护的 `recovery\first-administrator.json`，首次登录必须设置 MFA。既有演示账号密码不复制。首个管理员脚本只接受空生产账号表和独立迁移身份，不覆盖已有账号。

服务器证书有效期 397 天，CA 3650 天；安装后记录真实到期日并在到期前续期。当前病毒库来自现有已下载副本，公开验收前检查更新并做真实扫描。运维脚本仍由 `D:\AI-project\Codex-project1\scripts` 提供；保留该仓库、Node 和 PowerShell，不把 `tmp` 中的下载源误认为安装后的数据库运行程序。

## 初始备份、手动入口和回滚

本次没有既有生产环境可备份，也不对开发库执行任何数据库操作。安装计划先保存在受保护证据目录；初始化与迁移后，在公开开放前完成首份加密一致性备份及完整验证，然后正常停库。此初始备份作为新生产库的开放前恢复点。安装入口自身不打开 Tunnel、不创建计划任务、不按时间启停。

安装成功才生成 `C:\ProgramData\AIGamesProduction\Start.ps1`、`Stop.ps1`、`Backup.ps1`、`Status.ps1`，须由同一安装用户在管理员 PowerShell 执行（隔离账号凭据使用其 DPAPI）。`Backup` 会停止正在运行的业务，备份后保持关闭。`Stop` 请求排空后查询 `Status`，等 `writersStopped`、`databaseStopped`、`localBackupVerified` 确认，不能仅凭请求提交成功关机。

本地模式显式配置 `backupPolicy=local-only` 和 `localOnlyAcknowledged=true`，不设置 `offDiskRoot`。`backupVerified` 表示已满足所选备份策略；另报 `localBackupVerified`、`offDiskVerified`、`disasterRecoveryVerified`，后两项保持 false。缺省策略仍要求异盘，不因磁盘不可用自动降级。原 `DifferentDisk` 检查和需要异盘副本的备份清理规则均不放宽。本地副本和恢复密钥同时丢失仍不能恢复整盘故障。

回滚顺序：

1. 如已开启，执行 `Stop.ps1` 并等待入口关闭、写入者停止、备份及正常停库；不得结束其他业务进程。
2. 使用实际 `configuration\controller.json` 对 `production-postgres.ps1 -Action Unregister`，只注销本次已停止服务并恢复记录的 ACL。
3. 对实际 `runtime` 执行 `production-isolation.ps1 -Action Uninstall`，只移除记录的 WFP 与三个新账号。
4. 保留全部生产数据、备份、配置和证据；不删除或覆盖开发数据。账号原 SID 删除后无法重建，重新安装使用新的已审查方案，不能直接复用旧 SID 权限。

卸载属于单独确认的系统操作，安装失败不会自动删除账号或数据。上线后回滚前应保留最新业务写入，不能只恢复初始空库造成静默丢失。

## 尚待实际验收

安装准备验证：`npm run check` 142 模块；`npm test` 100 项中 98 通过、2 项真实 ACL 检查跳过；`npm run check:baseline` 130 需求/18 决策通过；全部 PowerShell 脚本解析和 `git diff --check` 通过。安装 Plan 已确认目标不存在、端口空闲、所需现有程序可用。路径检查拒绝 ProgramData 父目录、安装父目录和相似目录三种越界目标。以上均不是正式系统安装验收。

正式安装、真实账号/ACL/WFP/Job、数据库 TLS 与最小权限、手动 Start/Stop/Backup、真实浏览器登录/MFA、上传/扫描/审核/试玩/撤销、公网域名路由、故障保持关闭和进程端口清理。异盘与离线恢复材料备份未执行，不纳入通过项。整机重启与长期稳定性同样不能由短时测试替代。
