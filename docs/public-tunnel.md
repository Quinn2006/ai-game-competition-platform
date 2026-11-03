# 自有 Cloudflare 隧道

双击 start-local.cmd，选择 2 公网模式，再选择 1 临时隧道或 2 自有隧道。
自有模式支持 Cloudflare 控制台管理的隧道：一个连接器承载主站、试玩两条路由。

在 Cloudflare 控制台为该隧道配置两个 HTTPS 公网域名，服务分别为
`http://127.0.0.1:4320` 和 `http://127.0.0.2:4321`。不要覆盖 HTTP Host 请求头。
主站与试玩必须分离，建议使用不同的可注册域名；不能用相同域名或互为父子域名。

在项目 data 下新建 public-tunnel.json，以下仅为文档示例，必须替换为实际域名：

```json
{
  "mainOrigin": "https://www.example.com",
  "gameOrigin": "https://play.example.net",
  "tokenFile": "data/cloudflare-tunnel-token.txt"
}
```

将控制台该隧道的连接器 Token 单独保存到 tokenFile 指定文件，只写 Token，不写安装命令。
路径相对项目根目录；不要将 Token 发到聊天或提交 Git。data 已被 Git 忽略。
脚本使用 --token-file，避免将 Token 内容放进进程命令行。

仅检查本地配置：`start-local.cmd -Mode Public -TunnelMode Own -CheckOnly`。
直接启动：`start-local.cmd -Mode Public -TunnelMode Own`。
临时模式使用 `-TunnelMode Temporary`，本地模式使用 `-Mode Local`。

本地检查通过不代表云端路由正确。启动时等待连接注册；凭据错误、退出或超时会提示日志位置并清理本次进程。
启动后需用外网访问主站并实际试玩，确认 DNS、证书、两条路由及业务流程。
没有本地配置时会给出缺失提示，不会偷偷退回临时域名，也不会自动修改 Cloudflare 账号。
