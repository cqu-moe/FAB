# FAB · QQ 群管理

官方 QQ Bot 的入群审核、广告规则处理和每群独立配置控制面板。单管理员、单 Node.js 服务、SQLite 持久化。自动修改群名片暂缓。

## 本地启动

需要 pnpm 11.19.0 和 Node.js 22.13+（本地验证版本 22.22.3）。Node 22 的 `node:sqlite` 会显示实验性 API 提示。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# 编辑 .env，为 ADMIN_PASSWORD 设置独立的随机密码（至少 16 字符）
pnpm build
pnpm start
```

打开 <http://127.0.0.1:3030>，使用 `ADMIN_PASSWORD` 登录。QQ 凭据可先留空：人员名单、群规则和规则预览可独立使用，真实审批和撤回会明确显示未配置。

开发界面时，在 `.env` 将 `APP_ORIGIN` 改为 `http://127.0.0.1:5173`，分别运行 `pnpm dev` 和 `pnpm dev:web`。正式静态构建则使用 3030 对应的来源。请求来源必须与此配置一致，不能用 `localhost` 和 `127.0.0.1` 混用来绕开校验。

## 界面与设计系统

使用随仓库分发的 CQU Moe theme/ui 1.1.0（`.design/*.tgz`）与 Lucide 1.48.0；锁文件和 theme override 由 pnpm 管理。沿用原有 React/Vite 版本，不从公共 registry 获取同名设计包。

全局只有一个 ThemeProvider 和 Toaster，主题支持浅色、深色和跟随系统。Vite 在首帧注入包内主题脚本，服务端 CSP 只允许该脚本的 SHA-256，不开放任意内联脚本。业务 CSS 只使用共享语义变量，Tailwind reset 位于 base 层，避免覆盖组件样式。

## 接入 QQ

1. 在 [QQ 开放平台](https://q.qq.com/) 创建官方机器人，在服务端 `.env` 设置 `QQ_APP_ID` 与 `QQ_APP_SECRET`，重启服务。密钥不进入浏览器。
2. 将服务放在 HTTPS 反向代理后。设置 `APP_ORIGIN=https://你的域名`，只向反向代理开放本机服务端口。
3. 在开放平台填写 `https://你的域名/qq/events`，订阅 `GROUP_JOIN_REQUEST`、`GROUP_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`GROUP_ADD_ROBOT`、`GROUP_DEL_ROBOT` 和适用的消息接收状态事件。以当前管理端提供的事件选项为准。
4. 群主将机器人添加到目标群、设为管理员，并开启接收全量群消息。没有这些权限，普通成员广告或申请可能不会送达。
5. 经过签名验证的群事件会自动登记为“待配置群”，默认不开启自动化。也可在面板手动填写 `group_openid` 添加群；**这里不能填普通 QQ 群号**。
6. 给群命名、导入该群名单、配置审核和广告规则。先预览，再开启所需自动处理。
7. 在专用测试群实测：申请问题/答案、审批、非 @ 消息接收、撤回与禁言。面板“凭据已配置”仅代表配置存在，不代表权限验证通过。

回调按原始 HTTP Body 验证 Ed25519 签名，并检查签名时间窗口。普通事件持久化后返回 `{ "op": 12 }`；后台队列执行 QQ 操作。地址验证使用官方 `op:13` 协议，严格限制 challenge 内容，避免成为任意 JSON 签名入口。

## 入群审核

- 每个群单独维护名单、字段名称、未匹配处理方式和白名单。
- 问答模式按配置的问题名称精确提取。验证消息模式要求独立行或分号分隔，例如：

```text
姓名：示例同学
学号：00123456
```

- 做有限的全半角和空白归一化，不做模糊姓名匹配。缺失、重复、矛盾字段或 QQ 安全风险提示默认转人工。
- 姓名与学号匹配只能证明答案符合名单，不是本人身份认证。审批后关联本群成员 OpenID；已关联的人员被其他 OpenID 认领时转人工。
- 官方事件没有提供可直接信任的真实 QQ 号映射，**不会通过申请人自报 QQ 号完成账号核验**。名单 QQ 号用于管理员维护和官方 QQ 号白名单配置。
- 直接通过白名单分两种：本地成员 OpenID 白名单，以及同步到 QQ 官方自动审批策略的真实 QQ 号白名单。**QQ 官方白名单会在平台侧直接通过，绕过本地问答与风险提示检查**，只有可信账号才应加入。
- 只有启用自动化且审核模式为自动时，QQ 号白名单策略才会启用。修改白名单、暂停自动化或改成人工审核时，系统尝试同步官方策略；失败时会显示 `whitelistError`。此时旧策略可能仍生效，需在开放平台停用或重新同步。
- 官方限制单机器人最多 20 个自动审批策略；首版每群使用一个，仅需要真实 QQ 号白名单的群占用。官方默认策略一年到期，届时需重新同步。不会绕过平台限额。
- 面板“拉取待审申请”用于补查错过的申请，单次最多 1000 条；仍有更多时需先处理再拉取。

## 名单导入

使用 UTF-8 CSV（支持 BOM、标准双引号转义），表头必须为：

```csv
姓名,学号,QQ号,手机号
示例同学,00123456,100001,
```

先预览再导入，全部校验成功才写入，不静默覆盖。学号、QQ 号和手机号始终是字符串。学号在群内唯一；非空 QQ 号在群内唯一。Excel 导出前需把这些列设为文本，已被 Excel 丢弃的前导零无法恢复。每群首版最多 10000 人。

修改已绑定人员的姓名、学号或 QQ 号会清除关联，后续需重新核实。手机号仅存储在管理员可见的名单中，不写入群名片、不发送给 QQ 审批接口，也不用于广告分类。

## 广告处理

- 支持每群独立的禁止短语、禁止域名、成员 OpenID 豁免名单，以及观察/自动撤回/撤回并禁言三种模式。
- 文本和嵌套卡片的标题、描述、链接都会参与匹配。域名规则匹配本域和子域，不匹配 `blocked.example.attacker.example` 等伪装地址。
- 域名检测针对显式 HTTP/HTTPS URL；缩写网址、二维码和隐晦软广不保证识别。首版没有 OCR 或大模型接入。图片/附件可进入人工复核，不从不可信 URL 下载资源。
- 入群白名单不会自动成为广告豁免名单。
- 群主、管理员和机器人的消息不自动处置；发送者身份未知时转复核。
- QQ 官方撤回时限为消息发送后两分钟。过期记录显示过期，不能承诺补删；只有撤回成功才继续禁言。禁言最长 30 天。
- 观察模式记录命中结果，不调用撤回或禁言。人工操作仍需显式点击。

## 运行与数据

- 数据默认保存在 `data/fab.sqlite`，使用 WAL。首次创建的数据目录权限为 0700。请保护数据库、`.env` 及备份；SQLite 本身没有透明加密。
- 群配置、名单、记录和队列持久化；不保存普通未命中消息正文。消息按群和消息 ID 去重。QQ 入群申请在回调和拉取时可能返回不同请求 ID，因此还按群、成员、合法申请时间及验证信息等字段比对已有记录，保留首次收到的原始审批 ID；重复拉取只统计实际新增记录，不重新执行已处理或结果未知的申请。
- 同一申请的风险提示变化时保留两份材料，暂停尚未执行的自动审批并转人工。平台时间精度内内容完全相同的两次真实重申请无法区分；缺失或非法申请时间时仅按请求 ID 去重。这里的字段比对不等于官方提供的稳定申请 ID。
- 数据库绑定首次配置的 QQ AppID，更换机器人须使用独立数据库，避免跨应用混用 OpenID。更新同一机器人的 AppSecret 后重启即可。
- 处理记录（包括待复核内容）默认保留 30 天，可通过 `RETENTION_DAYS` 设置 1–365 天；去重标识保留 7 天。名单不会自动清除。
- 服务启动时，未完成的“执行中”操作转为失败并要求核对 QQ，不盲目重放可能已生效的动作。失败请求不会自动无限重试。
- API 限速按官方类别保守串行执行。流量过大时，广告可能错过两分钟窗口；首版仅支持一个服务进程，不适用于多实例并发部署。
- 配置采用版本号避免旧页面覆盖；规则/名单变化会把之前排队的自动操作转人工复核。
- 管理员通过 HttpOnly/SameSite Cookie 登录，状态修改验证来源，退出后撤销服务端会话；更换管理密码并重启会撤销已有会话。错误记录不保存 QQ 返回的原始文本或凭据。
- `/health` 只检查进程可响应。最后群事件时间不等于 QQ 在线保证，安静群不会持续产生事件。

停止服务或删除本地数据前，先停用/删除官方白名单策略；这类策略运行在 QQ 服务端，关闭本地程序不会自动终止它。

## 检查

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:design
```

测试使用腾讯公开签名向量、真实 SQLite 和 HTTP 应用边界；QQ 外部响应采用严格模拟，覆盖鉴权、来源校验、签名篡改、重复事件、名单匹配、跨群隔离、CSV 原子性、处置失败、过期消息和白名单同步顺序。通过这些检查不等于已在真实 QQ 账号上验证。

签名校验采用官方公钥与 challenge 的固定测试向量。文档中另一组普通回调的示例正文与签名无法对应复算，因此未将那组样例当作可通过的验收基准；没有据此放宽原始正文验签。

## 官方协议依据

- [Webhook 与事件订阅](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)
- [签名校验及测试向量](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)
- [Access Token 与请求地址](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html)
- [入群申请](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_join_request.html)
- [审批接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_approval_join_request_member_openid.post.html)
- [自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.post.html)
- [撤回消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html)
- [禁言](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html)

本项目没有 NapCat/OneBot 接入，没有自动改名，没有部署到远程环境，也不包含真实学生名单或 QQ 凭据。
