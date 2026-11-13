# D 盘安装前清理审查清单（2026-11-13）

当前仅完成只读盘点，未归档、未删除、未停止任何进程。最终生产安装位置已由用户改为 `D:\AI-project\Codex-project1\data\production`；C 盘目标不存在，没有本任务的 C 盘生产数据需要删除。

## 空间与边界

D 盘当前空闲约 0.94 GiB。以下 36 个候选目录文件逻辑大小合计 4.044 GiB，所有候选均无读取错误；不是承诺的净释放空间。归档必须保留在 D 盘受控目录，不能另占 C 盘。归档大小、NTFS 实际分配空间、压缩比均会影响结果。

当前安装前置检查要求至少 5 GiB 空闲；即使删除候选也必须扣除保留归档，不能保证已达门槛。不能先删除再补备份、不能通过删除现用程序或主库凑空间。

六个旧工作树均在 `git worktree list` 中，HEAD 已是当前 main 的祖先，Git 检查无已跟踪或普通未跟踪变更；这不代表其忽略的数据库、截图和临时文件已备份。旧克隆验证副本没有自己的 .git，不能把从其目录向上找到主仓库的 clean 状态当成副本已版本化。

本次进程检查未发现 PostgreSQL 进程、也未发现程序路径在项目 tmp 内的进程；部分旧测试库保留 postmaster.pid。执行清理前还必须逐个用对应集群的 pg_ctl status 核验，不能仅凭 PID 文件存在或不存在下结论；不编辑或删除单个 PostgreSQL 内部文件。

## 建议先归档、验证，再删除的候选

### 已合并工作树

| 完整目录 | 文件大小 MiB |
| --- | ---: |
| `D:\AI-project\Codex-project1\tmp\phase-4` | 244.3 |
| `D:\AI-project\Codex-project1\tmp\phase-5` | 298.4 |
| `D:\AI-project\Codex-project1\tmp\phase-6` | 522.4 |
| `D:\AI-project\Codex-project1\tmp\phase-6-main-merge` | 728.7 |
| `D:\AI-project\Codex-project1\tmp\phase-8` | 256.1 |
| `D:\AI-project\Codex-project1\tmp\workbuddy-merge` | 0.9 |

### 旧克隆验证副本

| 完整目录 | 文件大小 MiB |
| --- | ---: |
| `D:\AI-project\Codex-project1\tmp\fresh clone 验证-20261104-004820` | 236.9 |

### 旧功能测试现场

| 完整目录 | 文件大小 MiB |
| --- | ---: |
| `D:\AI-project\Codex-project1\tmp\community-db-20261102-083404` | 66.9 |
| `D:\AI-project\Codex-project1\tmp\community-db-20261102-083430` | 49.2 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-135923` | 49.5 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-135941` | 49.5 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-140001` | 49.7 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-140045` | 67.8 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-140253` | 67.9 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-193832` | 39.6 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-193929` | 68.4 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-194425` | 49.6 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-195338` | 66.9 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-195752` | 66.9 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-195835` | 70.6 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-200504` | 70.8 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-200708` | 50.9 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-200717` | 70.6 |
| `D:\AI-project\Codex-project1\tmp\operations-db-20261102-200926` | 50.6 |
| `D:\AI-project\Codex-project1\tmp\provider-suite-20261104093545` | 70.7 |
| `D:\AI-project\Codex-project1\tmp\provider-verify-20261104162101` | 81.7 |
| `D:\AI-project\Codex-project1\tmp\ui-review-db-20261104002858` | 66.6 |
| `D:\AI-project\Codex-project1\tmp\upload-regression-20261109` | 78.4 |

### 早期独立 PostgreSQL 测试集群

| 完整目录 | 文件大小 MiB |
| --- | ---: |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-004551` | 39.7 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-004815` | 72.3 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-005037` | 73.4 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-005850` | 73.2 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-104544` | 72.1 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-104634` | 74.0 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-112355` | 72.0 |
| `D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261102-200003` | 74.0 |

## 保留，不属于本次删除范围

- `D:\AI-project\Codex-project1\data\postgres`：开发主库。
- `D:\AI-project\Codex-project1\data\submissions`：既有作品。
- `D:\AI-project\Codex-project1\data\backups`：既有备份（包含 legacy-removal 历史归档）；本次未读取或宣称其能覆盖候选目录。
- `D:\AI-project\Codex-project1\tmp\phase2-postgres\runtime`：现用 PostgreSQL 程序，约 0.941 GiB。
- `D:\AI-project\Codex-project1\tmp\phase3-clamav\runtime` 和 `database`：现用 ClamAV 程序和病毒库，合计约 1.039 GiB。
- PostgreSQL 与 ClamAV 下载 ZIP 合计约 0.568 GiB，虽已解压，但直接同盘备份再删除不会释放净空间；本轮不计入候选。
- `tmp\production-recovery-*`、`tmp\isolation-*`、`tmp\production-runtime-*`、`tmp\upload-acceptance-20261109`：近期验收现场与证据。部分保护目录无法完整读取，不能把已统计字节当作完整大小，不因清空间删除。
- 两个受限 Tunnel 文件未直接读取、输出或修改。

## 后续操作与恢复方式（未执行）

批准后先复查 Git 状态、绝对路径、重解析点和集群停止状态；任何变化即停止相应目录的清理。归档目标拟为 `D:\AI-project\Codex-project1\data\backups\pre-production-cleanup-20261113`，不存在时新建，并保护为当前用户/管理员/SYSTEM 可访问，因为测试现场可能含凭据。不会使用 C 盘作为临时归档位置。

按目录逐个制作带时间戳的完整备份，保存文件清单与摘要，并从归档流式解压核对每个文件的大小和摘要后，才移除对应原目录。空间不足以先完成单个归档时，保留原目录并停止，不擅自跳过备份。Git 工作树通过 Git 正常移除并保留分支，不执行 reset/clean/强制移除；若忽略文件阻止移除，先说明具体结果，不扩大删除范围。

恢复时先恢复归档到新的核对目录；Git 源码可按保留分支重建工作树，再恢复相应忽略产物。数据库冷归档只用于找回已停止的旧测试现场，不算逻辑恢复演练或异盘灾备。若清理后空间仍不足，报告实际缺口，进一步操作另列明确范围。
