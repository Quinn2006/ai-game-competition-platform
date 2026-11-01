# 阶段 2 身份系统

2026-11-01。用户已确认 T-02/T-08，并授权项目内便携 PostgreSQL 合成测试与本地邮件预览。本轮实现可运行的身份接口及页面，不包含生产发布。

## 确认规则

- T-02：邮箱注册且验证后启用；密码 15—128 字符，不强制字符组合；验证链接 24 小时、重置链接 30 分钟且一次使用；普通会话闲置 30 分钟、最长 7 天，管理员闲置 15 分钟、最长 8 小时；重置撤销全部会话；限制账号及来源尝试；管理员强制 TOTP，普通用户可选；敏感操作重新验证，证明 5 分钟有效且绑定单次操作。危险操作额外确认并验证管理员密码。
- T-08：密码再验证后进入 7 天等待期并立即撤销会话，邮箱链接可取消；到期删除邮箱、密码、个人资料和收藏；评论匿名化保留、普通作品下架、参赛材料按 T-09；在任队长须移交，争议材料记录例外。

当前技术参数：来源每 15 分钟 60 次认证请求；账号/动作登录 10 次、注册/发信 5 次；敏感会话操作 10 次。所有尝试计入原子预算。仅信任 socket 地址，代理部署前需另定可信代理。限流键存带秘密的摘要，不保留原始 IP/邮箱。密码计算并行上限 2。TOTP 30 秒步长、前后各一步容差、禁止重放；8 个一次性恢复码，最长 10 年有效，注销申请时撤销。恢复码只显示一次。

## 本机启动

```powershell
Set-Location D:\AI-project\Codex-project1
.\scripts\local-identity-run.ps1 -State 'D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-005850'
```

访问 `http://127.0.0.1:4320/account`。该脚本启动指定回环数据库、显式迁移开发库并启动页面。Ctrl+C 停止页面；数据库单独停止：

```powershell
& .\tmp\phase2-postgres\runtime\pgsql\bin\pg_ctl.exe -D 'D:\AI-project\Codex-project1\tmp\phase2-postgres\run-20261101-005850\data' -m fast -w stop
```

`LOCAL_MAIL_PREVIEW=1` 只允许 development，邮箱为 `http://127.0.0.1:4320/dev/mail`，仅供合成数据。返回 to、purpose、token，最多 50 条，重启即清空。将对应 token 作为账号页片段 `#verify=…`、`#reset=…`、`#cancel=…` 打开确认表单；片段不会进入服务器访问日志，页面立即清除地址栏令牌。预览校验 Host、回环地址及 Fetch Metadata，正式/测试环境不可用。没有数据库、密钥、邮件适配时，身份 API 返回 503。

首个管理员使用 `scripts/identity-admin.mjs`，参数为已验证的开发邮箱。脚本要求 development 配置与库内环境标识，不创建默认账号或密码，赋权后撤销会话、记录审计。下一次登录必须设置 TOTP。已登录管理员可用页面调整其他账号角色，不可修改自己角色；变更需确认、密码和 MFA，撤销目标会话。

PostgreSQL 程序由官网下载页指向的 [EDB 便携发行包](https://www.enterprisedb.com/download-postgresql-binaries)下载，版本 18.6，实际包地址 `https://sbp.enterprisedb.com/getfile.jsp?fileid=1260609`。本机计算 SHA-256 为 `E2246BA91D22345BC3D017586C09EDE52D9DF180B1EEB480F050445F1CAD84E2`，未获得独立供应商签名验证。程序、随机凭据、合成数据库和预览均在已忽略的 tmp 目录，没有安装系统服务或改变 PATH。

## 数据和安全边界

- 新增 003 身份表及 004 审计例外表，不修改已提交的 001/002。空库可回退，非空数据拒绝回退。
- scrypt N=131072/r=8/p=1，随机盐；会话和一次性令牌只存摘要；TOTP 密钥用 AES-256-GCM 加密并绑定账号。SESSION_SECRET 需稳定保存，直接更换会使现有 MFA 无法解密；正式轮换流程尚待阶段 8。
- HttpOnly、SameSite=Strict Cookie；正式模式加 Secure、__Host- 前缀。POST 校验 Origin、JSON 类型和 16 KiB 上限。账号行锁、令牌消费、成功操作审计在同一事务内。
- 公开接口仅返回 id、昵称、头像、简介；本人资料不接受角色/所有者字段，当前可编辑昵称和简介，头像上传尚未实现。昵称 1024 字节、简介 8192 字节为技术上限，T-18 最终编辑长度仍未决定。
- 管理敏感读取与角色变更需绑定会话/动作/目标的一次性证明；审计包含操作者及目标 UUID，不记录密码、令牌或正文。失败请求及登录失败也入审计。
- 每分钟清理过期令牌、会话、限流和到期注销账号；审计按每表每批 500 条清理，普通错误 30 天、安全事件 6 个日历月。按记录保留例外包含原因、批准人、复查时间；过期复查不自动删除，显式解除后恢复清理。建立例外与清理共用事务锁。例外管理适配器尚未公开为后台页面。
- `deletionParticipants` 为未来模块提供事务内 check/finalize；当前没有团队、评论、收藏、作品、赛事表，因此只对身份数据执行并验收注销。未来模块必须注册参与者并测试队长阻止、收藏删除、评论匿名化、作品下架与赛事材料例外，不能声称已完成这些尚不存在的数据联动。
- 本地账号是合成测试用途；正式数据库最小权限、TLS、真实邮件投递/重试、密钥轮换及备份删除重放仍须验收。正式入口未接真实邮件，保持身份功能不可用，不能启用开发预览代替。

## 验证

`npm test`、`npm run check`、`npm run check:baseline`；真实数据库执行 `npm run test:postgres`，需全新可丢弃 ai_games_test、APP_ENV=test、DATABASE_URL 和 CONFIRM_DISPOSABLE_DATABASE=ai_games_test。测试最终故意篡改测试迁移账本验证拒绝，不能在该库直接重跑或当开发库使用。可先停止本任务集群，再运行 local-identity-db.ps1 创建新的状态目录；它不删除旧证据。详细实测见 verification.md。

技术依据：[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[Node.js 24 Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。2026-11-01 核对；具体产品期限来自本轮用户确认。
