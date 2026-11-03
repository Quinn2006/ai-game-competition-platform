# 首次安装验证（2026-11-04）

验证源：GitHub main 与本地改动前 HEAD 均为 `9f93787`。在项目忽略的 `tmp/` 下导出该提交，叠加本次启动脚本改动；测试目录名称包含空格与中文，不复制作者的 `.env`、账号、作品或 PostgreSQL 数据。没有修改原主库。

- Windows / PowerShell 7，Node.js 24+，PostgreSQL 18.6，ClamAV 1.5.4。
- `setup-local.ps1`：真实执行 npm ci、初始化独立集群（55448）、10 个迁移、6 个演示账号及 freshclam 官方更新。测试为节省下载复用了现有病毒库文件作为更新种子，随后 freshclam 成功更新并校验；没有实测从零下载完整病毒库。工具程序使用本机现有程序路径，路径持久化后在新进程生效。
- 实际运行 `start-local.ps1 -Mode Local`：ClamAV PONG；`/health/ready`、`/discover`、`/account`、`/studio` 均为 HTTP 200。未改页面视觉，本次未做浏览器视觉验收。
- Ctrl+C 后网站报告 `app.stopped`；扫描器退出。数据库独立 stop/start 前后逐表行摘要一致，完成后停止测试集群；4320、4321、3310、55448 无监听残留。
- 再次安装：已有账号新建数为 0，逐表行摘要不变；给父进程设置不可连接的 DATABASE_URL，安装仍使用测试实例自己的凭据，验证环境变量不会将迁移引向其他数据库。
- 仅存在 `.env` 的不完整配置：安装返回失败，不创建 data，原文件摘要不变。
- `npm run check`：110 个模块语法通过。
- `npm test`：71 项，69 通过、2 跳过、0 失败。
- `npm run check:baseline`：130 条唯一需求、18 条决策通过。

边界：未在一台全新 Windows 机器上安装系统工具；Windows PowerShell 5.1、其他操作系统、生产部署不在本次验收范围。运行所需工具仍须用户先安装，源码仓库不分发数据库、密钥或工具二进制。
