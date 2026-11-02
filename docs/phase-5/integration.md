# 阶段5本地联调记录

2026-11-02，分支 `codex/phase-5-community`，仅使用新建的 `ai_games_test` PostgreSQL 数据库和回环 HTTP 服务。扫描结论由**测试脚本注入的 clean 替身**提供；本记录不构成真实病毒扫描、正式对象存储或生产隔离验收。

运行：

```powershell
.\scripts\local-community-db.ps1 -Runtime D:\AI-project\Codex-project1\tmp\phase2-postgres\runtime\pgsql\bin -Port 55649 -Flow
```

结果：`PASS: HTTP upload → admin review → public profile/search → sandbox asset → guest valid play → like/favorite/comment/metric → revoke hides all`。先在端口55648的空库发现脚本心跳样本不足10秒，调整到8次后在端口55649的另一空库通过；未修改业务计时规则。

脚本实际执行迁移001—007，建立普通作者、管理员和另一账号的真实会话，通过主站HTTP上传ZIP。发布前试玩及公开详情返回404；作者不能领取审核，管理员领取并批准；缺少公开资料时仍不可见。作者填写资料后，公开详情及模糊搜索可见，其他账号编辑被403拒绝。游戏能力URL提供隔离HTML，详情嵌入模式的CSP只允许同源父页面。游客持第一方Cookie建立会话，服务端根据连续前台心跳和交互标记结算一次；随后点赞、收藏、评论和平均时长排序均能读取该作品。管理员撤销版本后，详情、社区状态、试玩和此前发放的游戏能力URL均不可读取。

合成浏览器联调记录见 [development.md](development.md)：真实沙箱iframe内可信点击、前台累计和退出后展示1次有效试玩，桌面及手机社区操作通过。此次新增脚本验证正式HTTP路由与数据库事务连接，不替代管理员在测试环境的人工验收。

仍未验收：真实ClamAV扫描及恶意包、生产对象存储与隔离域名、完整真实账号注册/邮件/MFA浏览器流程、前后台切换与崩溃及跨日/游客转登录的浏览器端到端场景。客户端可伪造部分试玩行为，异常队列需要人工核查。阶段5的本地功能联调通过，整体验收保留这些边界。
