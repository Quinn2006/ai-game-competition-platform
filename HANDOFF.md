## 2026-11-15：D 盘正式安装与本机功能验收完成（当前）

- 最终生产目录 `D:\AI-project\Codex-project1\data\production`，独立 55441、Manual 服务 AGP-PostgreSQL-Production；新建生产库，保留开发库与作品。C:\ProgramData\AIGamesProduction 未创建，未执行旧清理候选删除；临时浏览器认证配置已移除。
- 公网主站/试玩固定域名已验证，首管理员通过正式网页设置 MFA，实测仅密码拒绝、密码+动态码成功。密码、验证器密钥、恢复码仅在受保护 recovery 目录，不打印、不提交。合成作品 aec87e99-6243-43e3-b0e9-c9ed3c6ec173 已完成真实上传扫描、领取审核、公开匿名桌面/390×844 点击计分、二次验证撤销；撤销后详情/试玩/旧资源链接全部 404。浏览器会话已关闭。
- 正式 TLS/最小权限/真实 ClamAV clean+EICAR 通过。用户管理员窗口执行真实 ACL/WFP/管道拒绝与 Job 资源检查通过；resource-acceptance-8cfde82d029440e195b81b45ddb85852.json：内存超额拒绝、CPU 约0.90%、主站五次200/11–13ms。
- manual-cycle-63ca403b233048b5887a7f36ab3ab688.json：Stop、停机 Backup、Start 全部通过。实际加密备份独立恢复至新 55442 集群（D 盘 restore-checks/579699c5-cb66-47b6-9676-8d8a3223bf32），逐表/文件核验、MFA 重加密登录、旧会话失效、撤销保留通过，恢复集群已停，源库未改。证据 installed-restore-1794661089254.json；1216ms 仅小数据步骤，不承诺 RTO。异盘仍未验证。
- 后续 2026-11-14 21:27:58 再次安全关闭，最后 readiness=200 且受管进程存活。2026-11-15 已在一次性文件复现 Get-Content 读锁与原子替换冲突（第122次 EPERM）。read-shared-json.ps1 使用共享删除并在解析前关闭句柄；atomic-json.mjs 对短暂占用限时重试，持续拒绝仍关闭，控制器保留 lastLeaseFailure。并发250次、短暂占用、持续占用三项真实Windows回归通过。
- 用户最后手动启动 PID5704，startedAt=2026-11-14T17:55:12.346Z（上海11月15日01:55:12）；固定隧道01:55:37连接。runtime-observation-1794679132520.json：193145ms内90次本机健康检查通过，最大946ms，6次公网健康通过。01:59最终核查 active/公网200/撤销作品404，汇总 installation-acceptance-1794679157044.json。后续查询须实时核对，不把此历史状态当成当前事实。
- 最终全量检查：147模块、106测试中104通过/2默认ACL跳过、130需求/18决策、全部PowerShell解析与diff空白检查通过。正式安装功能范围已完成，异盘、整机重启、容量与长期可用性未验证；操作入口与管理员凭据位置见 docs/production-installation-2026-11-13.md。仅本地提交，不推送/tag/release。
- 工具侧提权此前被自动审批以 blocked by policy 拒绝，没有绕过。需要管理员操作时由用户运行已准备入口；用户已授权正式安装/公网验收，不再重复询问范围。受限两个 Tunnel 文件始终只由获准的原启动器消费。

## 2026-11-14：D 盘正式安装已执行，公网验收待继续（历史）

- 用户自行删除 mod，D 盘安装前空闲 35.08 GiB，明确要求继续；本任务没有执行清理清单中的任何删除。已将目标改为 `D:\AI-project\Codex-project1\data\production` 并实际安装；C 盘生产目录未创建。
- `AGP-PostgreSQL-Production` 为 Manual 服务，独立集群 55441、空生产库已受控迁移，随机首管理员 `admin@wsyz-aigames.de5.net` 已创建但 MFA 尚未完成；密码只在受保护 recovery/first-administrator.json。三个真实账号 agp1164b01452m/g/v、NTFS/WFP/Job 安装完成，专项探针尚未全部执行。
- 初始安装证据 tmp/production-install-resume-20261113-status.json passed=true；data/production/evidence/installation-result.json installed=true。初始及失败启动后的本地加密备份均验证通过。仅本地策略为用户明确接受，offDiskVerified/disasterRecoveryVerified=false。
- 已修复新目录初始化令牌权限、运行账号父目录解析权限、ClamAV 冷启动就绪等待；只操作新生产树，原父 ACL 留存备份。最近一次启动到业务 ready 后 Tunnel 子进程失败，控制器安全排空（graceful=true/forcedAbort=false）、备份并停库。12:28:59 上海记录见 evidence/b2a6faf2-a551-403e-a3b0-e33d301994a9.shutdown.json；服务后查 Stopped，四个相关端口无监听。
- 新增 ManagedStatusFile 握手，只有原启动器报告 connected 才记录 active，尚未实际重跑。随后提权启动加浏览器命令被自动审批拒绝（blocked by policy，无更具体原因）；未换工具绕过。已通过问题卡请用户在管理员 PowerShell 7 执行 D 盘 Start.ps1。下一步先读取新 *.tunnel.json 和 controller-state.json，不重复读受限 Tunnel 文件或重新运行 Install。
- 用户第一次用普通窗口执行被拒绝，随后在管理员窗口启动控制器 PID 2892。隧道阶段报找不到 cloudflared，已复现净化环境缺少 PATHEXT 的扩展名查找问题，改为 cloudflared.exe。用户再次启动提示旧控制器锁仍被持有，已定位并修复排空超时计时器未清除导致约 140 秒退出延迟；两项专项测试通过，等待旧控制器自然退出后再由用户启动，不能强杀或绕过审批。12:34:28 最新关闭记录 graceful/backupVerified/databaseStopped=true。
- scripts/verify-production-isolation.ps1 和 tests/production-boundary-probe.mjs 已准备真实账号权限/网络拒绝检查，尚未执行。还需实际手动正常开放、Stop/Backup、资源限制、浏览器登录/MFA、上传扫描审核试玩撤销和公网验收。详细现状、入口、回滚见 docs/production-installation-2026-11-13.md。下方 C 盘与“未安装”记录均为历史。

## 2026-11-13：正式安装准备（历史，以上方当前记录为准）

- 最新用户决定覆盖下方 C 盘计划：用户允许正式安装和公网验收，但要求不占 C 盘；随后明确选择最终安装到 `D:\AI-project\Codex-project1\data\production`，先整理可清理清单。C 盘目标不存在，未执行任何正式系统安装。安装器仍指向 C，改为 D 并验证前严禁执行 Install。
- 已完成只读空间清单 `docs/production-cleanup-review-2026-11-13.md`：36 个候选合计 4.044 GiB（归档前逻辑大小），D 空闲约 0.94 GiB；净释放量尚未确定，扣除归档后仍可能达不到当前安装器的 5 GiB 门槛。六个工作树已合并且 Git clean，但忽略产物仍须备份；克隆验证副本无独立 .git。未发现 PostgreSQL 进程，清理前仍需逐个核验集群。
- 只授权整理清单，尚未授权删除；未归档/删除/移动任何目录。现用 PostgreSQL/ClamAV 运行程序及病毒库、开发主库、作品、既有备份和近期验收证据均保留。清理若获准，备份和中间产物也必须在 D 盘，先核验完整归档再删除，不占 C 盘。
- 接手确认 `main@1ecb086` 干净、版本 0.3.0，相关端口无监听/服务无遗留。C/D 仍同属磁盘 0，D 仅剩约 0.94 GiB，C 约 42 GiB。
- 用户选择新建空生产库、保留开发数据；明确表示没有异盘并要求继续。记录为接受暂缺异盘，不能宣称灾备实测通过。已确认两个历史域名，不再要求用户重复填写。
- 新安装入口 `scripts/install-production.ps1`，只读 Plan 已运行；实际目标、权限、服务/账号、初始备份和回滚见 `docs/production-installation-2026-11-13.md`。计划使用 `C:\ProgramData\AIGamesProduction`、独立 55441 集群，保留开发主库。支持显式本地备份例外并分别报告灾备未验证，默认异盘检查不变。
- 当前仅修改仓库源码/文档，尚未执行正式安装、创建账号/服务、修改系统 ACL/WFP、启动数据库或公网。系统操作待具体范围确认，不能复用过去一次性测试授权。两个受限 Tunnel 文件未直接访问。后续先核对本段之后的新记录和实际状态。
- 准备阶段验证：142 模块、98 测试通过/2 ACL 跳过、130 需求/18 决策、PowerShell 解析及 diff whitespace 通过；只读安装 Plan 和三种越界路径拒绝通过。新增首管理员拒绝非生产/非迁移身份及非空账号表测试，未执行正式数据库操作。

## 2026-11-13：生产部署与恢复实施中，改为手动启停

- 基准 `main@e105609`，版本 0.3.0，接手时工作区干净。用户经来源聊天明确取消 08:00—22:00 定时开关：只有手动 Start/Stop/Backup，没有时段限制、计划任务或开机自动开放；已落实代码、测试和现行文档，旧部署计划顶部注明历史条款失效。
- 当前实现：受控生产数据库初始化/迁移及角色分离、CA/verify-full；外部 PostgreSQL TLS/hba 配置和可回滚手动服务；沿用隔离监督器的许可与排空；AES-GCM 一致性备份、异盘识别、独立恢复、MFA 重加密/旧会话及令牌失效、012 删除账本、保留清理计划、数据库切换/回滚。操作说明 `docs/production-deployment-recovery.md`。
- 已完成真实一次性 PostgreSQL 18.6/TLS、真实 ClamAV、HTTP 上传审核试玩、加密备份/独立恢复、恢复后登录/MFA/HTTP 试玩撤销、后续删除账本覆盖、切换回滚。最新已读证据 `tmp/production-recovery-eab78721-b0e2-491d-a5fd-2b821e8312c8/evidence.json`：passed=true、databaseStopped=true、restore.elapsedMs=1640；原库在独立恢复过程中未改动，切换/回滚仅操作该测试集群。端口 55680/3311 无监听。此集成应用 ACL 为注入探针，不是正式身份验收。
- 已跑 138 模块语法、95 项测试（93 通过/2 ACL 跳过）、130 需求/18 决策、PowerShell 解析和 diff whitespace 检查；9 项恢复专项全部通过。原生 Windows Job 已实测控制管道关闭后进程终止、端口释放、维护凭据不继承到子进程；修复 PowerShell 环境数组拼接和同步 stdin 等待问题。
- 用户明确回复“继续一次性服务验收”，已按授权通过 UAC 创建并测试 `AGP-PostgreSQL-Acceptance` 虚拟身份服务，仅操作新 tmp 集群和 55680/3311。最终 `tmp/production-recovery-d1e5c8fe-de9d-4e92-a697-ba99d80e8c17/evidence.json`：passed/windowsService/tlsAndRoles/cutoverRollback/laterDeletionOverlay/databaseStopped/serviceRemoved 全为 true，恢复 877 ms。外层 `tmp/service-acceptance-20261113-run5-status.json` 为 passed=true/serviceRemaining=false。最终无测试服务，55680/3311/4320/4321/55440 无监听。
- 服务分支实际修复了 NULL 虚拟账号密码、HBA include 引号、PostgreSQL 回收 WAL 后的 ACL 回滚，以及缺失服务时清理命令退出码。前三个失败现场均未保留运行服务；run3 已恢复最初两个测试树 ACL，run5 已恢复第四轮剩余 ACL。所有现场保留，不修改/删除数据库内部数据文件。服务复验入口 `scripts/run-production-service-acceptance.ps1 -Action Plan|Run`，不复用已有目录/同名服务。现有授权覆盖这一测试服务范围的修复复验，不等于正式部署授权。
- 参数（已由上方当前记录更新）：两个域名可从本文件历史验收确认；异盘仍缺，用户接受暂缺。真实运行 DifferentDisk 检查已拒绝 C/D 互备。取消定时开关后不能再承诺夜间每日备份或约一天 RPO；损失窗口取决于最后一次成功的手动备份。
- 未读取/输出两个受限 Tunnel 文件，未改动/启动 data/postgres 或正式数据库；除上述已清理的测试服务及新测试树 ACL 外，没有改动其他服务、计划任务、既有目录 ACL 或公网配置；没有推送/tag。现有 start-local.ps1 只新增由同一既有程序消费 Own Tunnel 的 ManagedTunnelOnly 分支，并核对与安装的公开来源一致；实际公网执行仍需授权。
- 后续以顶部正式安装方案为准。更新后的专用应用账号监督器、完整手动控制器/公网启停、正式 TLS/ACL、整机重启仍待验收；异盘未完成。不要把已通过的小型恢复（0.877—1.64 秒）当作正式 RTO。恢复包、staging 明文、测试密钥和数据库均在忽略目录，保留用于核查，不能纳入提交。

## 2026-11-12：专用账号系统隔离验收通过

- 本任务基准 `main@544fc01`，初始实现提交 `69d9fd7`，版本仍为 0.3.0。主站、试玩、ZIP 校验已拆分；生产入口要求 `ISOLATION_CONFIG`，开发入口保留。当前修复和准确权限边界见 `docs/production-isolation.md`。
- 用户明确回复“继续系统验收”后，已通过 UAC 在新建一次性环境执行专用账号、NTFS、WFP、Job 及完整业务验收。发现并修复默认命名管道 ACL 无法跨账号调用、部署缺失 database/migrations；管道先核对服务端 SID，再只向指定客户端授权。
- `tmp/isolation-acceptance-20261112/attempt4`：真实三个账号、真实主站 ACL、PostgreSQL 55673、ClamAV 3311，上传→扫描→预览→审核→匿名试玩→撤销通过；试玩终止后主站 live 200、ready 503。试玩账号 256 MiB 限额拒绝超额分配，1% CPU 测试实测约 1.15%，主站五次响应 200、2–15 ms。`attempt6` 权限复验通过，校验账号访问主站授权管道为 EPERM；网络限制为 EACCES，扫描器仅校验账号可达。
- 128 模块检查、86/86 测试（启用真实 ACL、无跳过）、130 需求/18 决策、PowerShell 语法和 C# 编译通过；当前用户 Job 限制再次通过，证据 `tmp/job-acceptance-a323d200aa1c431aa30dc80a7fdacd6b`。早期独立校验异常输入和本地浏览器桌面/手机检查亦通过，详情在运行文档。
- 每次安装后均卸载本次六条 WFP 规则和三个账号，最终核查账号均不存在。测试数据库和扫描器已停止，3311/4370/4371/4372/4373/55673 无监听。受保护测试文件及唯一 `.bak` 归档保留，不直接复用旧账号 SID；没有修改主库、注册服务、开启公网或读取 Tunnel 配置，没有推送。
- 本次系统隔离验收范围已完成；真实生产数据库 TLS、正式安装/登录/MFA、公网 HTTPS、长期容量、灾备及定时开关仍未验收。业务测试使用独立 ai_games_test 和合成会话，不得据此宣称正式上线。后续生产部署需单独准备实际环境并验收，不重复运行业务测试到已含数据的测试库或主库。

## 2026-11-10：主库上传、审核发布及公网匿名试玩已完成

- 用户指定作品归属管理员账号，Admin06 在浏览器手动登录及完成两步验证；通过正常工作台上传、领取审核并提交通过，没有绕过认证或直接改库发布。
- 公开作品：https://wsyz-aigames.de5.net/work?id=11a6ea81-477d-4027-9168-8be7805f9075 。发布版本 `27a53df4-4ee6-47d3-b22e-856be298511e`，状态 `approved`、扫描 `clean`；SHA-256 与原始 ZIP 一致。
- 实际公网大包单请求曾返回 524，已改为最多 1 MB 分块、绑定会话、逐块重新校验权限、内存预算及 15 分钟过期清理，完整收齐后才进入原有扫描审核流程。27 个分块全部成功，完成扫描接口 200。随后列表刷新遇到一次 502，刷新确认版本已经保存；界面现在区分已上传与页面更新失败。
- 匿名身份接口 401；审核前试玩 404，审核后搜索、详情和独立试玩成功。桌面及 390×844 手机尺寸进入战斗、拖动移动及得分增长；全部 41 个公开资源 200 且与原包逐字节匹配（入口仅增加平台桥接脚本）。退出后公开详情记录 1 次有效试玩。
- 官方 ClamAV 病毒库更新、运行中扫描器重载成功，再次扫描原包与 41 个文件，42 次均 clean。115 模块检查、74 项测试通过（2 跳过）、130 条需求及 18 条决策检查通过。
- 两个自有公网域名已连通；用户禁止查看的两个配置文件未直接读取、输出或修改。当前通过 `start-local.ps1 -Mode Public -TunnelMode Own` 启动；电脑、Node 服务和隧道必须持续运行才能对外服务。进程状态以后应实时核查。
- 公网截图和资源验证结果在忽略目录 `preview/public-upload-20261110`；详细记录见 `docs/upload-acceptance-2026-11-09.md`。未推送 GitHub，未做真机、长期稳定性、容量及灾备专项验收。
- 2026-11-11 继续时，网站、数据库、扫描器均未监听，公网 530。使用原自有隧道启动命令恢复，健康检查 200；主库作品仍存在，匿名详情和试玩接口 200，未重新上传或重复发布。停止期间公网不可用，用户需要保持启动进程运行。

## 历史记录：公网恢复前的连接受阻

- 本次目标：完善上传，用用户提供的《最后的星轨》原始 ZIP 验证上传、审核和匿名游玩。
- 当前 `main`：补齐工作台公开资料表单、上传进度与错误提示、发布资料校验、匿名试玩可见性校验和慢速上传时限；本次修改及回归记录见 `docs/upload-acceptance-2026-11-09.md`。
- 本地已完成真实浏览器、PostgreSQL、ClamAV 验收；115 模块检查、72 项测试通过（2 项跳过）、130 条基线和 18 条决策通过；数据库、真实扫描和 HTTP 全流程集成通过。作品只发布在独立测试库，未导入主库。
- 用户已配置固定域名和 Token，明确禁止查看 `data/public-tunnel.json` 与 `data/cloudflare-tunnel-token.txt`。仅允许既有启动程序使用，不要直接读取、输出或修改这两个文件。
- 2026-11-10 执行 `start-local.ps1 -Mode Public -TunnelMode Own`：格式检查通过，默认 QUIC 连接超时；仅在本次进程设置 `TUNNEL_TRANSPORT_PROTOCOL=http2` 重试，日志确认 HTTP/2，仍出现 `TLS handshake with edge error: EOF`，超时退出。两个公网域名均返回 HTTP 530 / Cloudflare Error 1033。失败发生在数据库/网站启动前，本轮未启动主库或发布作品。
- 本机存在 Clash 进程；无法仅据此判断根因。下一步先由用户检查代理/网络/防火墙到 Cloudflare 7844 的出站连接，或换网络对照，再重试原启动入口。连接成功后验证两条路由及完整作品流程；仍需确认主库作品归属和管理员审核身份。不要用临时隧道替代，不把测试库作品当成主库数据。
- 诊断日志位于忽略目录 `tmp/public-tunnels/08b109c57f1e4a46a4110ced1d9a817e.log`（QUIC）和 `1270b719f7404cf7977dfc678463b593.log`（HTTP/2）。本次失败的隧道进程已由启动脚本清理。
- 本机测试证据在 `tmp/upload-acceptance-20261109`，验收服务器工具 `tests/integration/upload-live.mjs`；测试端口 4360/4361，测试 PostgreSQL 55669。进程是否仍运行需实时核查。没有推送代码。

---

2026-11-02：阶段4最终分支已与包含阶段5的 main 合并；本地回归通过后推送 GitHub。以下为阶段4/5历史交接。

# 阶段 4 与阶段 5 交接

目标：在独立分支完成公开展示、搜索与发现。用户已确认 T-14/T-15/T-18 方案，并要求等待阶段 3 完成后再联调。

- 分支：`codex/phase-4-discovery`，工作树 `D:\AI-project\Codex-project1\tmp\phase-4`；基础提交 `8c80e67`。主工作树仍是阶段 3 的并行工作，未改动。
- 已实现：公开服务/页面、搜索和私人历史、热门汇总/过滤/限流、精选与配置、资料编辑、006 迁移、单元/HTTP/真实 PostgreSQL 契约测试。
- 已验证：31 项测试、41 模块语法、130 条需求基线；独立 PostgreSQL 搜索/权限/迁移/留存检查；三个浏览器视口及主要公开交互。
- 未完成：正式阶段 3 联调；006 故意尚未注册到 migrationFiles；详情内嵌试玩暂未接入；不能称阶段 4 全部完成。
- 下一步：先读 `docs/phase-4/development.md` 和 verification.md，检查两个工作树实际 Git 状态。阶段 3 完成后合并其提交，按 development.md 数据依赖步骤注册迁移、合并服务器组装与注销清理、接入创作台和试玩，完整测试上传→审核→公开搜索→试玩→撤销隐藏。
- 无推送、部署或正式数据库操作。预览、数据库状态、凭据在忽略目录；不要提交这些文件，不要用测试契约表替代正式 005。

## 阶段5集成更新

上述阶段4交接为历史记录。阶段5分支已合入阶段3与阶段4，注册006/007，组装服务和注销清理，接入资料编辑、详情试玩容器、社区及平均时长排序。当前路径 tmp/phase-5；验证与剩余边界见 docs/phase-5/development.md。原阶段3/4分支及工作区未被修改。

2026-11-02：新增一次性数据库HTTP完整联调，结果及真实扫描等剩余验收边界见 docs/phase-5/integration.md。阶段5本地联调通过，生产和人工验收仍未完成。

2026-11-02：阶段5已合并至 main；合并冲突仅在 src/web/games.mjs，保留主分支的重试防串线修复及阶段5计时逻辑。主分支39项单测、63模块语法、130条基线、真实PostgreSQL回归与完整HTTP联调通过。阶段3真实扫描验收记录仍在 docs/phase-3/verification.md；阶段5联调使用测试扫描替身，见 docs/phase-5/integration.md。
