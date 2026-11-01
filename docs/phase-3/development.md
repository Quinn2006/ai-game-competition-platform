# 阶段 3：上传、审核与隔离试玩

2026-11-01：本地实现已交付；真实扫描、生产存储与隔离验收受阻。没有部署、推送或公开发布。分支 `codex/phase-3-upload-isolation`。

## 本轮确认

用户在本轮分别确认下列业务方案及“本地私有目录 + ClamAV 适配器，真实服务不可用时禁止通过”的实施范围。

- T-03：1 MB = 1,000,000 字节；默认 ZIP 100 MB、展开 300 MB、500 条目（目录也占一个条目，避免目录耗尽）；根入口严格为 `index.html`。允许 html/css/js/json/txt/png/jpg/jpeg/gif/webp/svg/ico/mp3/ogg/wav/m4a/mp4/webm/woff/woff2/ttf/wasm；拒绝加密、链接、嵌套压缩和危险文件，作者确认资源授权。当前支持 UTF-8 路径、stored/deflate；ZIP64、多卷及其他压缩方式明确拒绝。
- T-04：新版本审核时旧版继续公开。回滚限历史已通过且未撤销版本，管理员一次性再验证、确认和原因必填；回滚不重新扫描。提交必须早于服务端截止时刻。审核目标 2 个工作日，由运营执行，尚无工作日历或超时提醒系统；驳回分类安全/结构/内容/其他。五种审核状态外另存撤回、撤销标志。
- T-13：默认禁网，作品首次通过后才能上传带域名申请的新版本，域名变更随版本完整重审；仅精确 HTTPS 域名来源，无通配符、自定义端口或路径权限。跨域重定向目标仍须满足 CSP，不能依靠路径白名单限制跳转。外链与请求白名单分开，外链在主站显示目标、确认后使用 noopener/noreferrer 打开。沙箱仅 `allow-scripts`，主站通过独立 MessageChannel 验证类型、递增序号、频率及各字段。
- T-16 存档部分：重新开始保留存档；清档单独确认；同作品同存档版本沿用进度，格式不兼容时作者增加存档版本，保留旧档。计时、身份合并、日界仍待后续阶段确认。

## 模块和数据

`uploads/zip.mjs` 检查 ZIP 中央目录与本地头、路径、类型、实际解压体积、CRC 和重叠；始终在内存解析，不将包内路径写入磁盘。`scanner.mjs` 按 [ClamAV 官方 INSTREAM 协议](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)扫描原包与每个展开文件，非明确 clean 均拒绝预览和领取审核。正则代码疑点只辅助人工复核，不是恶意代码判定器。

`service.mjs` 复用真实身份事务，锁定作品串行修改。个人作品由所有者管理，管理员不能冒用作者上传/撤回。作品、不可变版本、扫描结论和操作事件写入 PostgreSQL；迁移 005 的触发器阻止版本内容更改。团队实体及队长投稿对接阶段 6，当前不伪造团队数据。注销参与者在到期清理事务中下架普通作品并去除作者关联。

本地文件在 `tmp/private-games/development/{quarantine,review,release}`，键为服务器生成的 UUID；无静态公开目录，禁止覆盖为不同内容。已写入的相同内容允许幂等重试。游戏服务使用 256 位随机、30 分钟有效的能力 URL；每个资源请求重新验证公开指针或预览身份，版本撤销/下架后旧 URL 失效。解压缓存最多一个版本，读取时验证 SHA-256。临时隔离对象、历史版本和扫描证据暂无自动回收，运行者需关注磁盘容量；不得直接删除审核证据。生产对象生命周期、赛事档案及审计到期例外须在阶段 6/8 对接 T-09 后验收。

## 启动

Node.js 24；依赖安装 `npm ci --ignore-scripts`。复用阶段 2 的本地 PostgreSQL 启动器，新增 `-Games`；默认端口仍为 55432。本次已经建立的独立开发实例可这样启动：

```powershell
.\scripts\local-identity-run.ps1 -State 'D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-104634' -Port 55434 -Games
```

该路径仅适用于本次机器；在其他机器用 `scripts\local-identity-db.ps1` 创建实例后采用其实际输出路径。启动器仅执行本地迁移，不安装系统服务。

- `/account` 注册、验证、登录；开发邮件在 `/dev/mail`，仅合成数据。
- `/studio` 创建作品、上传、检查结果、撤回、预览、管理员审核及回滚。
- `/play?work=作品实际UUID` 只读取已通过的当前公开版本。链接由工作台生成，不手工猜测 ID。
- 游戏服务默认 `http://127.0.0.2:4321`，主站 `http://127.0.0.1:4320`。

`LOCAL_GAMES=1` 仅允许开发环境和指定回环游戏来源，不能用本地驱动启动生产游戏服务。可配置 `UPLOAD_MAX_BYTES`、`UPLOAD_MAX_EXPANDED_BYTES`、`UPLOAD_MAX_FILES`、`GAME_LOAD_TIMEOUT_MS`（默认 30000）、`CLAMD_PORT`（默认 3310）。可选 `SUBMISSION_DEADLINE` 必须包含 `Z` 或明确时区；未配置时普通作品无提交截止，赛事时间由阶段 6 接入。

ClamAV 必须由运行者实际提供，回环监听、病毒库更新、StreamMaxLength/MaxScanSize/MaxFileSize 必须与平台限额协调；当前未自动下载或安装。服务缺失时上传记录为扫描异常，只能撤回后重提，不能通过或公开。集成测试中的扫描替身仅由测试代码注入，正式入口没有“跳过扫描”开关。

## 游戏作者接入

平台在根 HTML 前注入桥接脚本。当前 opaque-origin sandbox 不支持游戏直接使用 localStorage/IndexedDB 或 Service Worker；采用平台接口存档：

```javascript
window.addEventListener('platform:save', event => {
  const previous = event.detail; // null 或当前存档
  // 恢复游戏状态；收到此事件后 PlatformGame 已可使用。
});
// 玩家操作后：PlatformGame.save({ level: 2 });
// 自定义资源进度：PlatformGame.progress(50);
// 再次读取：PlatformGame.load();
```

存档每个作品/格式版本最大 65536 个 JSON 字符，浏览器配额失败会提示。预览不读取或写入公开试玩的进度。普通 HTML 游戏无需为页面加载添加 SDK；复杂异步游戏应提供进度和实际就绪信号。原生媒体尝试自动播放，受阻提示点击开启；自建 AudioContext 游戏仍需在自身交互中恢复声音。

加载/心跳是运行提示，不是可信有效试玩证据。恶意游戏可伪造自己的心跳，浏览器主进程完全卡死时主站也可能无法及时提示；不能据此在阶段 5 计分。后台不累计任何试玩计数（本阶段尚未接入计分）。

## 回滚与验收

迁移 005 只允许空表回退；含作品或审计时明确拒绝，必须保留数据并向前修复。不要对真实数据运行测试套件。`tests/browser-games-server.mjs` 是只读合成组件夹具，单独监听 4330/4331，不是应用启动方式。

管理员人工验收：提供真实 ClamAV → 注册作者/设置管理员 MFA → 上传正常包及 EICAR 测试包 → 人工复核疑点并发布 → 更新、撤回、驳回、重提、回滚和撤销 → 确认旧能力 URL 失效及事件记录。随后对正式独立域名、对象存储 ACL、DNS、CSP 白名单重定向、真实手机音频/全屏完成验收。未经上述实测，不将阶段 3 整体验收标记为完成。
