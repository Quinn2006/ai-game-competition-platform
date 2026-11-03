# Windows 正向 ACL 验收方案（生产本地私有存储）

日期：2026-11-03
分支：`fix/production-local-storage-hardening`
适用对象：`backend/src/platform/production-local-storage.mjs`、`backend/src/platform/acl.mjs`

## 1. 目的与范围

前一轮交付的 ACL 自检在真实主机上必然 fail closed：D:\ 与 C:\ 卷根携带
Authenticated Users 显式 ACE，而原实现把守卫链一路延伸到卷根，因此不改卷根
ACL 就无法启动。本方案定义三级验收，证明新的「可信存储边界
（PRIVATE_STORAGE_TRUST_ROOT）+ 边界以下全量校验」策略在不修改任何系统
ACL、不创建任何 Windows 服务账号的前提下，正向路径可用且负向路径仍然
fail closed。

**明确边界（未获批准不得越过的操作）**：
- 不修改 C:\、D:\ 或任何既有目录的 ACL；
- 不创建 Windows 服务账号 / 本机账号；
- 不修改 DNS、不启用公网；
- 不执行数据库迁移。

L1 测试只对「测试自己新建、随即删除的临时目录」执行 icacls，不属于上述
系统级操作；L2 的服务账号与数据目录 ACL 属于系统级操作，逐条列出、
**仅在操作员书面批准后执行**。

## 2. 信任模型（本轮实现的语义）

守卫链 = 存储根目录 → 逐级父目录 → **可信边界（含）**；未配置边界时延伸到
卷根（与旧行为一致，仍 fail closed）。边界必须满足：

1. 是 PRIVATE_STORAGE_ROOT 的祖先（含相等），且不是卷根（配置层拒绝）；
2. 继承已禁用（protected），所有者属于受信主体（服务账号 / SYSTEM /
   Administrators / 声明的 EXTRA_SIDS）；
3. Allow ACE 仅授予受信主体；任何宽泛主体（Everyone、Authenticated
   Users、BUILTIN\Users、Guests、Power Users、Backup Operators）、未知
   SID、无法解析主体、不可信所有者、剥离服务账号必要权限的 Deny ACE，
   均导致启动或 readiness 拒绝（fail closed）；
4. 服务账号在存储根与全部区域目录上必须实际持有必要权限
   （ReadData | WriteData | AppendData/CreateDirectories | ReadAttributes |
   Delete | ReadControl），且进程身份 SID 必须等于配置的账号 SID。

边界**以上**的目录不进入探针范围。其上主体即使持有整树删除 / 重命名
能力，也只能造成可用性损失（整树消失），无法注入、读取或替换内容：
边界 protected 阻断继承注入，白名单阻断 ACL 扩权，readiness 周期复检
在刷新窗口内发现越权（503），读取路径始终校验 size + SHA-256（sidecar
.meta 与可选的数据库 expectedDigest 双重绑定）。

残余风险（声明并接受）：边界以上主体删除/重命名整树（DoS）；两次
readiness 复检之间最长一个刷新窗口（默认 30s）的 ACL 变化延迟；
Windows 无 GetFinalPathNameByHandle，最后一次检查与 open/link 之间的
TOCTOU 窗口仍由 fd 级校验收敛。以上均记录在交付评审文档。

## 3. L0 — 只读探针验收（无需批准，随时可跑）

```bash
export PATH=/d/Nodejs:$PATH
AGP_REAL_ACL_TESTS=1 node --test tests/production-local-storage-acl.integration.test.mjs
```

验证：真实 PowerShell 探针能解析 SID、以数值返回 rights、守卫链覆盖
data 目录及全部父目录；在本机因卷根宽泛 ACE 而 fail closed（预期结果，
不是缺陷）。

## 4. L1 — 正向路径验收（自包含临时目录，无需批准）

```bash
export PATH=/d/Nodejs:$PATH
AGP_ACL_POSITIVE=1 node --test tests/production-local-storage-acl.integration.test.mjs
```

测试内容（`real Windows ACL positive acceptance`）：
1. 在 OS 临时目录下新建一次性目录 `agp-acl-positive-<uuid>`；
2. `icacls <dir> /inheritance:r` 关闭继承；按 SID 精确授予
   当前进程身份、SYSTEM（`*S-1-5-18`）、Administrators（`*S-1-5-32-544`）
   (OI)(CI)F；
3. 以该目录同时作为 PRIVATE_STORAGE_ROOT 与 PRIVATE_STORAGE_TRUST_ROOT
   构造真实驱动：构造期同步断言通过（启动放行），readiness 以真实异步
   探针通过（200 语义），put/get 完整读写通过；
4. 结束后递归删除该目录，不留任何痕迹。

判定：测试通过 = 正向路径（受保护 ACL + 信任边界 + 真实探针）在本机
验证成功。上方 OS 临时目录的宽泛 ACL 被边界有意排除，正是边界语义的
演示。

## 5. L2 — 操作员级正式验收（需逐项书面批准）

前置批准项（未批准不得执行）：
- [ ] 创建专用本地服务账号（如 `HOST\svc-agp-main`）；
- [ ] 在指定数据目录（如 `D:\agp-data`）上执行 icacls。

步骤（获批准后）：

```powershell
# 1) 服务账号（批准后执行；SID 记录备用）
net user svc-agp-main /add
# 2) 数据根 = 信任边界：关闭继承，只授予受信主体
icacls D:\agp-data /inheritance:r
icacls D:\agp-data /grant:r "HOST\svc-agp-main:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
# 3) 存储根（边界之下，继承边界干净 ACE 后再显式保护）
mkdir D:\agp-data\prod-storage
icacls D:\agp-data\prod-storage /inheritance:r
icacls D:\agp-data\prod-storage /grant:r "HOST\svc-agp-main:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
```

以服务账号身份运行（runas / 计划任务 / 服务宿主，具体进程宿主属后续
部署阶段，本方案不展开），环境变量：

```
APP_ENV=production
PRIVATE_STORAGE_DRIVER=local
PRIVATE_STORAGE_ROOT=D:\agp-data\prod-storage
PRIVATE_STORAGE_TRUST_ROOT=D:\agp-data
PRIVATE_STORAGE_ACCOUNT_SID=<svc-agp-main 的 SID>
```

验收判定（全部满足才通过）：
1. 进程启动成功（构造期同步 ACL 断言通过，app.listen 达成）；
2. `GET /health/ready` 返回 200；
3. 以 Administrators 身份向 D:\ 添加 Authenticated Users ACE 不影响
   启动与 readiness（边界排除卷根）——该实验本身需要批准，可在虚拟机
   中进行；
4. 人为放宽存储根 ACL（如 `icacls <root> /grant "Users:(OI)(CI)M"`，
   需批准）后，readiness 在一个刷新窗口内转为 503；
5. 篡改任一对象字节或 .meta，读取被拒绝；
6. 删除 .meta 后重启，对象被隔离进 `_orphans`，不会被发布；
7. 回滚：删除测试目录或 `icacls <dir> /remove ...` 恢复；卷根 ACL
   全程不动。

## 6. 与代码的对应关系

- 边界与守卫链：`backend/src/platform/acl.mjs` `guardPaths(root, extra, trustRoot)`
- 所有者/身份/权限/Deny/继承校验：`acl.mjs` `evaluateAcl`（rights 数值化，
  generic 复合 ACE 展开）
- 异步限频 readiness 复检：`production-local-storage.mjs`
  `aclStatus()/refreshAcl()`（默认 30s 刷新、5s 最小探针间隔，可注入）
- 启动同步断言（fail closed）：驱动构造期 `assertStorageAcl`
- .meta 相对键与配对隔离：`readMeta(metaPath, key)`、`isolateUnpaired()`
- 数据库摘要绑定接口（保留，业务接线在后续轮次）：`storage.mjs`
  `get(area, id, { digest, size })` + `game_versions.digest`（迁移 005）
