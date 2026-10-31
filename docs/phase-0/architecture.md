# 阶段 0 架构决策与原型边界

2026-10-31。范围：需求基线、原型与技术候选。数据库迁移：无。外部服务绑定、公开部署、生产数据：无。

## ADR-001：模块化单体与环境边界

沿用计划书建议的模块化单体；身份、作品/版本/扫描、互动/试玩、比赛/评审/结算、通知/支持、管理/审计保持清楚模块接口。PostgreSQL 是已确认数据库。Next.js/TypeScript/Prisma 仍为阶段 1 候选，本次不安装框架。原型用 Node.js 内置 HTTP 和 node:test，无第三方运行依赖。

开发、测试、正式环境须分别使用数据库、对象存储空间、来源、服务账号与密钥；未审资源保留私有隔离区，受控扫描完成才允许预览，公开版本为不可变发布清单。测试不用生产身份数据。数据库只在私网访问；游戏来源无主站会话、数据库或管理权限。正式强制 HTTPS；本地回环 HTTP 仅用于原型。

阶段 1 配置边界：DATABASE_URL、OBJECT_STORAGE_ENDPOINT/BUCKET、MAIN_ORIGIN、GAME_ORIGIN_SUFFIX、SESSION_SECRET 由各环境注入；供应商确定前不生成假凭据或可运行的占位配置。服务端统一校验身份、资源授权、CSRF、输入及审计，CORS 不是鉴权。

## ADR-002：每作品独立来源 + sandbox

候选：每作品稳定独立来源，与主站使用独立站点/域名；主站 Cookie 仅 host scope，正式使用 Secure/HttpOnly、适当 SameSite 及 __Host- 前缀。禁止父域 Domain Cookie。预览与公开来源分离。

原型使用 127.0.0.1:4310（主站）、127.0.0.2:4311（A）、127.0.0.3:4312（B），不同主机避免 Cookie 仅按端口未隔离的问题。iframe 仅 allow-scripts + allow-same-origin，以便作品自己的 localStorage；不授予弹窗、表单、顶层导航及浏览器设备权限。两权限并用的前提是作品与父页严格异源，绝不能迁回主站同源。生产域名和 T-13 协议决定前保持候选。

替代方案：opaque origin + 主站存档代理权限更小，但原生存储不可用且扩大消息与存档接口；暂不选择。当前原型只验证同版本重载，不决定更新共享存档、清档或迁移策略（T-16）。

游戏响应 CSP 默认拒绝，脚本/样式/图片仅自身，connect-src none、worker-src none、frame-src none、object-src none、form-action none、base-uri none；frame-ancestors 仅主站。Host 严格匹配且静态路径用固定列表。正式策略还需合法游戏资源兼容性、白名单、重定向、导航与 WebRTC 等通道实测；CSP 不等于完全网络隔离。主动外链走受控宿主提示，不放开游戏弹窗。

## ADR-003：消息与试玩信号

消息形状：{v:1,type,session,seq}，仅 ready/heartbeat/interaction/error；校验精确 origin、source WindowProxy、会话随机值、字段集合、递增序号及频率。重载轮换 session。会话不是游戏无法获知的密码；这些验证防止其他窗口注入，不证明游戏诚实。诊断 probe 通道仅用于实验结果，不进入计分逻辑。

只有成功加载、前台至少 10 秒且发生实际交互才产生候选。continuous/cumulative 强制由调用者提供；1500 ms 心跳间隔上限只是测试参数。日去重时区、身份合并未实现，等待 T-16。服务端应签发短期会话，以服务端时间与资源记录核验序列，复合唯一约束落库、风险核查后才计数；这些属于阶段 5。

失效策略：iframe load 不证明游戏可玩；任意游戏 ready/心跳/交互均可伪造。无法验证成功加载或交互、断网、后台、错误、心跳过期时停止累计并不结算，显示阶段式加载/不确定状态和重试，不伪造百分比。真实卡死可能连宿主页事件循环一起阻塞，恢复后不得补记间隔。不能保证捕获所有崩溃；当前 V-08 结论是“不支持任意游戏的可靠真实性证明”，需最小接入协议、审核与服务端反作弊共同处理。

## ADR-004：计分与结果

公式按原件实现并保留 Number 运算精度，展示时才 toFixed(2)。这属于浮点原型，不能宣称金融级十进制精确；阶段 6 应决定 PostgreSQL numeric 或十进制定点/有理数计算并用同一示例及临界舍入回归验证。拒绝负数、非有限值、不安全计数、少于三名有效评委和不一致分母。不提供排名发布、同分最终裁决或自动剔除异常值，T-06/T-17 仍未决定。

## 依据

- [MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)：存储与 sandbox 权限边界。
- [MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)：精确目标来源、来源与消息校验。
- [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)：资源与嵌入约束；2026-10-31 查阅。
