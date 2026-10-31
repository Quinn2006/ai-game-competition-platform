# 本机环境实测

2026-10-31，工作区 D:\AI-project\Codex-project1，分支 main；开始时 Git 工作区干净。

|项目|观察结果|影响|
|---|---|---|
|Git|既有仓库；起始提交 13b51a5|复用，不嵌套初始化|
|Node.js / npm|v24.22.0 / 11.19.1|内置 HTTP、node:test 可运行；零 npm 依赖|
|Python|3.15.0；启动打印 real location 警告，但 XML 提取成功退出 0|标准库可用；不安装不兼容 MarkItDown|
|MarkItDown|未安装|改用 zipfile + ElementTree 提取正文/表格；不做 DOCX 修改或版式验收|
|agent-browser|0.40.0|独立会话 phase0-codex-project1|
|Chrome|doctor 报 156.0.8078.73；浏览器 UA HeadlessChrome/156.0.0.0|完成 Chromium 单引擎初验|
|docker / psql|Get-Command 无结果|未确认 PostgreSQL 开发实例|
|PostgreSQL 服务|Get-Service 无权访问服务控制管理器|不能据此断言未安装；阶段 1 再核验实例|
|对象存储、邮件、AI、病毒扫描|未连接、未选供应商|后续对应阶段集成前确认|
|本地权限|初次浏览器状态目录不可写，回环连接受限；经正常工具授权后运行成功|受限环境可能需要工具权限；没有更改防火墙/代理或系统设置|

开发运行仅使用回环地址 4310—4312。无数据库迁移、无外网发布、无账户/秘密配置。预览截图已被现有 .gitignore 的 preview/ 排除；备份、临时文件、环境变量、密钥及 node_modules 等已有排除规则，本次无需新增。

提取完整性：两个 DOCX 来源路径、SHA-256 与段落/表格行数见 sources/manifest.json；附录提取恰好 130 个唯一 D/DF/B/S 编号和 18 个 T 编号。正文与附录的公式、补充规则及 T/V 段落已人工文本核对。此方法不提取图形、页眉或批注，原 DOCX 仍为权威；未声称版面完全还原。
