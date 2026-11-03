# 克隆后的首次安装（Windows）

每个人使用自己的本地实例。代码目录可自行选择，所有路径按项目位置解析，不依赖作者的盘符。当前安装入口支持 Windows PowerShell 5.1 / PowerShell 7；其他系统尚未验收。

## 1. 准备工具

- 安装 Node.js 24 或更新版本（包含 npm），重新打开终端。
- 安装或解压 PostgreSQL，准备包含 `initdb.exe`、`pg_ctl.exe`、`postgres.exe`、`pg_dump.exe`、`pg_restore.exe` 的 bin 目录。本项目已使用 PostgreSQL 18.6 验证；无需另建系统服务或使用安装器创建的数据库。已有 `data/postgres` 时，工具主版本必须与其中的 `PG_VERSION` 一致。
- 安装或解压 ClamAV，准备包含 `clamd.exe`、`freshclam.exe` 及其依赖的目录。本项目已使用 ClamAV 1.5.4 验证。首次安装脚本通过 freshclam 获取官方病毒库，需要联网；失败时会报错，不绕过扫描。
- 安装 Git，或下载仓库源码 ZIP 并完整解压。

工具请从各自官方渠道获取：[Node.js](https://nodejs.org/)、[PostgreSQL](https://www.postgresql.org/download/windows/)、[ClamAV](https://www.clamav.net/downloads)。工具程序可放在项目外的固定位置，运行数据存放在项目内。不要把程序装在可随时清理的 tmp 目录。

## 2. 克隆并安装

```powershell
git clone https://github.com/Quinn2006/ai-game-competition-platform.git
cd ai-game-competition-platform
$pgBin = Read-Host 'PostgreSQL bin 目录完整路径（包含 initdb.exe）'
$clamAvBin = Read-Host 'ClamAV 目录完整路径（包含 clamd.exe）'
.\setup-local.cmd -PgBin "$pgBin" -ClamAvBin "$clamAvBin"
```

若两个目录已加入 PATH，可直接双击 `setup-local.cmd`。脚本不会自动下载或安装系统软件。

不要预先复制 `.env.example` 为 `.env`：初始化会生成真实配置及随机密钥。脚本检查工具后执行 `npm ci --ignore-scripts`，初始化本地 PostgreSQL、应用数据库迁移、建立 README 列出的本地演示账号、更新病毒库。首次数据库默认监听 `127.0.0.1:55440`；如被另一实例占用，可在首次初始化前设置 `$env:LOCAL_PG_PORT='55441'`。网站固定使用 4320/4321，同一电脑不要同时启动多个副本的网站。

再次执行会复用完整配置和已有数据库，账号密码不会重置。遇到仅部分配置存在时会停止，保留现场供检查；不要为了重试删除已有 data。完整初始化后若病毒库更新失败，可修复网络再运行同一安装命令。

## 3. 日常使用

双击 `start-local.cmd`，选择 `1` 本地启动。网站就绪后浏览器会打开 `http://127.0.0.1:4320/discover`。可以注册自己的账号；本地演示管理账号见 README。公网分享是另一个可选步骤，按 [隧道指南](public-tunnel.md) 配置。

Ctrl+C 关闭网站与本次启动的扫描器；数据库保持运行。停止数据库：

```powershell
npm run local:stop
```

## 4. 本地数据位置

|位置|内容|
|---|---|
|`data/postgres/`|账号、团队、作品记录、评分、排行等 PostgreSQL 数据|
|`data/submissions/`|作品 ZIP、截图和附件|
|`data/backups/`|执行备份命令后生成的备份|
|`data/exports/`|业务导出文件|
|`data/clamav/`|新安装实例的病毒库、扫描配置和日志|
|`data/local-tools.json`|本机 PostgreSQL 与 ClamAV 工具位置|
|`data/credentials.json`、根目录 `.env`|本机凭据与会话密钥|

这些私有文件均被 Git 忽略；克隆者不会得到作者的业务数据，每人首次启动是独立的新实例。不要删除 data，不要同步 PostgreSQL 内部文件，不要将 data 或 .env 上传 GitHub。更换机器使用 [备份与恢复流程](storage-layout.md#备份与恢复)，保留密钥，并重新配置工具路径。

此流程用于本地运行；不代表生产部署或真实 AI 服务已配置。
