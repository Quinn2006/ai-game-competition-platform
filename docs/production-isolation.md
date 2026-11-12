# 生产运行隔离实现与验收

2026-11-12。主站、试玩和 ZIP 校验已拆分；三个专用 Windows 账号、NTFS、WFP、Job 限制及完整业务链路已在一次性环境实际验收。此结果不等于正式生产部署、数据库 TLS 或公网验收完成。

## 进程和信任边界

| 进程 | 入口 | 允许访问 | 不传入 |
| --- | --- | --- | --- |
| 主站 | `backend/src/server.mjs` | PostgreSQL、私有原件、输入暂存、派生资源晋级 | 数据库超级用户身份 |
| 校验 | `backend/src/validator.mjs` | 本次输入副本、校验输出目录、ClamAV | 数据库地址/密码、会话密钥、审核原件、备份 |
| 试玩 | `backend/src/game-server.mjs` | 最终分发目录、专用授权管道 | 数据库地址/密码、会话密钥、审核原件、校验输入、备份 |

主站上传先保存隔离原件，再把不可变 UUID 输入副本交给校验进程。ZIP 结构检查、解压及原包/每个文件的 ClamAV 扫描全部在校验进程执行；单任务超过 110 秒时校验进程退出，主站的调用在 120 秒内失败。每次仅接受一个校验任务。失败不会创建可公开的版本。

校验输出使用 SHA-256 文件名，原始 ZIP 路径只存在于清单内。主站按清单核对每个输出摘要，再写入校验进程不可写的最终分发区；清单摘要保存在数据库版本 `metadata.serving`，沿用 005 迁移的不可变 payload 触发器，无需迁移。写入数据库前的失败可留下孤立派生文件，但没有数据库关联和票据，不能自动公开。输入副本调用结束后删除，隔离原件保留；阶段输出和孤立派生文件暂保留用于诊断，需离线核对后清理，当前没有自动回收或容量承诺。

试玩只读取已生成的文件。每次 GET、HEAD、桥接脚本请求均经主站重新校验票据、当前发布版本、作者会话或评委资格。撤销、撤回、下架、版本变更和评委资格变化沿用业务查询即时影响后续请求。主站返回该请求所需的版本 ID、单个文件摘要/大小和公开网络白名单，不返回用户会话、数据库信息或原件路径。试玩再次校验真实文件字节，不缓存授权或解包结果。浏览器 CSP、opaque sandbox、Host 校验、no-store 和桥接脚本保持原有行为。

旧版本没有隔离清单时返回 `REVALIDATION_REQUIRED`，不会退回在试玩请求中解包。现有开发入口保持原实现；测试可以显式注入 `embeddedGames:true` 验证原组装，但生产 CLI 没有这个开关。

## 内部授权

使用 Windows 本机命名管道，主站授权、校验、试玩健康检查各使用不同的 256 位随机服务密钥。服务密钥与主站会话密钥分离，由对应角色配置目录的 ACL 保护。请求和响应分别使用 HMAC-SHA256；签名绑定服务名、方向及请求随机 nonce，校验时间窗并拒绝重复 nonce。响应还必须绑定原请求 nonce，防止伪造管道返回许可。未知身份、错误签名、重放、超时或通道消失均拒绝分发。

应用层认证证明持有专用服务凭据，不是 Node API 直接查询 Windows 对端 SID。监督器等待管道建立，核对创建者 SID，再用同一原生句柄设置受保护 DACL：仅 SYSTEM、Administrators、服务端账号和指定客户端账号可访问。主站授权管道只向试玩账号开放，校验和试玩控制管道只向主站开放，不向 Everyone 放行。真实跨账号调用和无关账号拒绝已通过下述验收。消息、连接和并发数量均有限制；日志不输出管道凭据、会话或完整试玩票据。

## Windows 安装、启动与回滚

`scripts/production-isolation.ps1` 默认只输出 Plan。安装只接受 `tmp/`（验收）或 `data/submissions/` 下全新的独立目录，拒绝既有目录和 reparse point。复制源代码使用 backend/frontend/node_modules/package.json 及 database/migrations 白名单，迁移文件供启动时核验使用；不复制 `.env`、data、Git 或备份，不另建源码项目。

安装创建三个随机强密码的本地非管理员账号，凭据通过 DPAPI `Export-Clixml` 保存，仅管理员和 SYSTEM 可读；启动需使用执行安装的同一管理员身份解密。运行环境由白名单重新构建，试玩和校验不会继承调用者环境。主站凭据文件只进入 `main/main.env`，生产数据库名、角色和 `verify-full` 要求仍由现有配置验证，安装程序不迁移或启动数据库。

| 子目录 | 主站 | 校验 | 试玩 |
| --- | --- | --- | --- |
| private（quarantine/review/release 等） | 修改 | 无 | 无 |
| inbox | 修改 | 只读 | 无 |
| stage | 只读 | 修改 | 无 |
| serving | 修改 | 无 | 只读 |
| 各角色配置/可执行文件 | 对应角色只读 | 对应角色只读 | 对应角色只读 |
| 各角色 temp | 对应角色修改 | 对应角色修改 | 对应角色修改 |

`scripts/windows-isolation.cs` 通过 `CreateProcessWithLogonW` 使用专用账号，进程创建时挂起，加入 Job 后才恢复执行；不开放 breakaway，Job 句柄关闭终止进程树。主站 1024 MiB/50% CPU/4 进程（允许 ACL 探针）；校验 768 MiB/25%/1；试玩 256 MiB/15%/1。单进程限制防止通过另一个可执行文件逃离按专用 node.exe 路径设置的网络规则。

六条持久 WFP ALE connect 规则仅匹配本次复制的两个专用 node.exe：试玩拒绝全部 IPv4/IPv6 出站连接；校验只允许 TCP `127.0.0.1:3311`（可在安装时指定扫描端口），拒绝其他地址、端口、协议及 IPv6。内部授权走管道，不需 IP 放行。启动前确认规则存在。WFP 使用 [Microsoft ALE 过滤模型](https://learn.microsoft.com/en-us/windows/win32/fwp/permitting-and-blocking-applications-and-users)，CPU 限制使用 [Job Object CPU rate control](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information)。这是共享 Windows 内核的进程隔离。

启动是前台监督器，不注册系统服务、计划任务或 Tunnel。主站异常退出时停止本次进程树；试玩/校验退出时保留主站，readiness 返回 503，不自动无限重启。主站监听先于试玩就绪，不能把监听成功当作对外开放条件，必须等待 `/health/ready`。Ctrl+C 关闭 Job，会终止未结束任务；它不代替生产排空、备份和时段控制器。原 `start-local.cmd` 行为不变。

审查命令（只读）：

```powershell
.\scripts\production-isolation.ps1 -Action Plan -Root D:\AI-project\Codex-project1\tmp\isolation-os-20261111
```

本次用户已确认并执行的系统验收范围：

- 新目录 `D:\AI-project\Codex-project1\tmp\isolation-os-20261111`。
- 新账号 `agp15a2167d4bm`、`agp15a2167d4bg`、`agp15a2167d4bv`。
- 只设置该新目录树 ACL；不改主库、既有目录或卷根 ACL。
- 完整业务验收另建 `tmp/isolation-os-db-20261111` 一次性 PostgreSQL 集群，并仅收紧这个新测试目录的 ACL；保存原 SDDL 到安装目录的 `disposable-database-acl.bak`。实际 `pg_control` 的读取和写入句柄探针必须被所有应用角色拒绝，数据库只允许主站凭据经 TCP 访问。
- 六条针对该树专用 node.exe 的 WFP 规则，规则 UUID 在创建前写入安装清单。
- 本地测试监听 4372/4373，复用独立 ClamAV 3311；数据库拒绝探针目标为 55673。
- 不注册服务、不启用公网、不读取 Tunnel 配置或现有秘密。

以后复验仍需准备全新空测试库，并在管理员 PowerShell 执行以下流程；不能把普通终端的模拟结果当成完成：

```powershell
$root='D:\AI-project\Codex-project1\tmp\isolation-os-20261111'
.\scripts\local-identity-db.ps1 -Port 55673 -State D:\AI-project\Codex-project1\tmp\isolation-os-db-20261111
.\scripts\production-isolation.ps1 -Action Install -Root $root
.\scripts\test-windows-isolation.ps1 -Root $root -DatabaseState D:\AI-project\Codex-project1\tmp\isolation-os-db-20261111
.\scripts\production-isolation.ps1 -Action Uninstall -Root $root
```

前提：独立真实 ClamAV 已在 127.0.0.1:3311 就绪。测试完按新建集群的绝对 data 路径使用 pg_ctl 正常关闭，不操作 data/postgres；停止本次专属扫描器。

验收使用合成 canary，要求试玩无法读写数据库/审核/备份/密钥替身，能读但不能写分发文件，真实跨账号认证管道成功；网络探针必须得到 `EACCES`，连接拒绝或超时均不算网络隔离通过。校验必须能连接真实扫描器，不能连接其他目标，也不能访问主站授权管道（Windows 返回 `EPERM` 或 `EACCES`）。`-DatabaseState` 会进一步在三个专用账号、真实 Job 与 WFP 限制下运行完整 HTTP 流程，使用真实主站账号 ACL 探针；故障检查由监督器只终止其持有的试玩 Job，随后验证主站存活及 readiness 503，并以试玩账号施加内存/CPU 压力检查主站响应。上述分支已经实际执行。

`scripts/run-windows-isolation-acceptance.ps1 -EvidenceDirectory <新的验收证据目录>` 封装本次固定目录的安装、测试和 finally 卸载；证据目录必须位于项目 `tmp/isolation-acceptance-` 前缀下。可加 `-PermissionsOnly` 仅重验账号、目录、网络和管道，避免对已含测试数据的库再次运行业务测试。只导出合成报告，不复制密钥、凭据或作品。重试仅归档已卸载的本次运行目录为唯一 `.bak`，不覆盖历史现场。

安装中途失败保留清单和现场，按同一个 Root 执行 Uninstall；它先确认没有该目录的存活 Node 进程，再删除精确记录的过滤器和新建账号，核对 SID/描述防止误删。不删除文件或数据库；保留保护目录供复查。账号删除不可恢复原 SID，重新验收需新目录/新账号。安装前既有配置没有被覆盖，无需恢复原文件。生产安装需单独提供 `MainEnvironmentFile` 和实际 HTTPS 来源；不要把文档示例域名用于真实部署。

## 已取得证据

- 2026-11-12 专用账号完整业务及资源验收：`tmp/isolation-acceptance-20261112/attempt4/status.json` 为 passed/cleanup 均 true；主站/校验/试玩 PID 为 15524/16296/28980。真实主站账号 ACL、PostgreSQL 55673、ClamAV 3311、上传到撤销链路和试玩终止后的主站存活全部通过。登录会话仍为合成夹具。
- 实际测试库 `data/global/pg_control` 对三个应用账号的读/写句柄均拒绝；试玩对分发文件只读，对私有原件/审核/备份/主站密钥 canary 均不可读写；工作进程没有继承数据库或会话秘密环境变量。试玩 IPv4/IPv6 出站和校验非扫描目标均为 `EACCES`，校验仅扫描端口成功连接。
- `attempt4/resource-evidence.json`：试玩账号 256 MiB Job 拒绝 640 MiB 分配，主站仍返回 200；测试专用 1% CPU 上限下实测约 1.15%（5 秒采样，验收容差 3%），主站五次请求均为 200，耗时 2–15 毫秒；Job 关闭后压力进程消失。该短时检查不代表长期容量验收。
- 首轮系统执行发现并修复了 Node 默认管道 ACL 不允许跨账号连接、部署目录缺少迁移校验文件。无关账号管道探针实际返回 `EPERM`，断言已兼容两种明确的权限拒绝码；不会将超时、断连或连接成功判为权限隔离通过。
- 最终权限复验 `tmp/isolation-acceptance-20261112/attempt6/status.json` 为 passed/cleanup 均 true，校验账号的 `unauthorizedPipe` 为 `EPERM`。每轮卸载均调用原生 WFP API 删除六条记录规则；最终三个专用账号均不存在。本次 PostgreSQL 和 ClamAV 已正常停止，3311/4370/4371/4372/4373/55673 无监听。受保护测试目录及 `.bak` 归档保留供管理员核查，账号删除后不应直接复用其旧 SID ACL；重验使用新安装。没有改动主库或 Tunnel 配置，没有公网发布。
- 三次独立 PostgreSQL + 真实 ClamAV + 生产文件驱动 HTTP 链路通过。三进程 PID 分别为 5084/34732/19340、11360/2156/17888、10832/28036/35884；主站在测试 runner 内运行，子服务使用清空的环境。
- 上传→扫描→作者预览→审核→匿名试玩→撤销通过；文件/.meta 替换拒绝审核，最终资源被篡改后返回 503，撤销后资源和桥接脚本返回 404，撤回后旧作者预览票据失效。强制结束试玩后主站 `/health/live` 200、`/health/ready` 503。
- 独立校验进程的真实 ClamAV 测试通过：畸形 ZIP、超量展开、EICAR、输入摘要篡改均拒绝，干净文件生成清单并晋级；进程退出后管道不可连接。
- 认证管道错误密钥、重放、断连、派生清单/文件篡改、路径穿越、junction、重复写入测试通过。
- 真实 Windows ACL 的 L0 和 L1 均通过。修复 PowerShell 7 继承模块路径导致 Windows PowerShell 5.1 ACL cmdlet 加载失败；探针显式使用自身 PSHOME Modules。
- `scripts/test-windows-jobs.ps1` 在当前用户身份下实测：128 MiB Job 的分配拒绝；子进程创建拒绝；1% CPU 上限实测约 0.97%；Job 关闭后 PID 消失。证据：`tmp/job-acceptance-7cfd9f2766424aaf91ea9e360354a77e/evidence.json`。
- `agent-browser` 本地 HTTP 浏览器检查：桌面和 390×844 视口加载独立 iframe，重新开始正常，sandbox 为 allow-scripts，无页面脚本错误；截图在 `preview/isolation-desktop.png`、`preview/isolation-mobile.png`。不是公网 HTTPS/TLS 验收。
- 最终回归：`npm run check` 128 模块；开启真实 ACL 后 `npm test` 86/86 通过、无跳过；`npm run check:baseline` 130 需求/18 决策；PowerShell 语法、C# 编译和 `git diff --check` 通过。测试专属数据库、扫描器和网站进程已停止，4370/4371/3311/55672/55673/55674 无监听。

边界：数据库只在全新 `ai_games_test` 中模拟生产环境标识，连接使用测试池，登录会话为合成夹具；早期同用户集成使用注入 ACL 探针，2026-11-12 的专用账号分支已替换为真实主站账号 ACL 检查。真实生产 PostgreSQL TLS、正式环境安装、登录/MFA、公网 HTTPS、长期容量、断电恢复、服务注册和灾备仍未在本次验收。当前仍为 100,000,000 字节上传限制和内存分块，200 MB 持久续传、时段开关与完整备份不属于本次隔离实现。本次不能据此批准正式上线。
