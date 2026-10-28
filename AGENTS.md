# FAB

官方 QQ Bot 群管理服务。用户决定暂缓自动修改群名片，不引入 NapCat/OneBot。

- `src/shared.ts` 是服务端验证与面板的数据契约。
- `src/server/app.ts` 管理 HTTP、登录、CSRF 与官方回调；`engine.ts` 持久化决策和执行；`qq.ts` 负责官方签名/鉴权/限流；`store.ts` 管理 SQLite。
- `src/web/` 是 React 控制面板。仅使用真实服务端状态；演示数据必须明确标注并与正式数据库分开。
- 不把 OpenID 当作 QQ 号；真实 QQ 号白名单由官方审批策略处理。不能把姓名/学号匹配称作本人身份认证。
- 修改签名、鉴权、匹配、队列或 QQ 接口前核对当前官方文档。不要用成功 HTTP 状态推断业务操作成功，也不要重放结果未知的操作。
- 配置、名单及所有写入都限定到群。图片消息不能自动声称已通过文本规则审核。
- 凭据、SQLite、学生资料、导入文件和浏览器测试产物不可提交。
- 验证命令：`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm check:design`。UI 改动另做真实浏览器桌面/窄屏检查。
- 保留用户全局 Git 身份和隔离 worktree 规则；提交前检查有效身份。未取得真实凭据时完成本地验证并明确真实 QQ 验收缺口。

## 界面消费规则

- 使用 CQU Moe Design 1.1.0；从 `node_modules/@cqu-moe/ui/dist/START-HERE.md`、`DESIGN.md`、`docs/agent-start.md` 开始，按页面查布局、组件、状态、通知和动效文档；类型以公开声明为准。
- 基础组件只从 `@cqu-moe/ui` 导入，图标从 `lucide-react` 按名称导入。复用 AppShell、ContentContainer、PageHeader、PageState，不复制基础组件，不覆盖 `.ds-*` 内部选择器。
- 保留单一 ThemeProvider/Toaster 和首帧主题脚本；CSP hash 必须与 themeInitScript 一致。CSS reset 放在 base 层。
- 样式使用语义变量；浅色为浅灰画布与白色卡片，深色为石墨灰；颜色只表达真实状态，不添加装饰渐变。
- 设置与导入草稿只留内存，失败保留输入。手机端保留全部操作，输入至少 16px、触控目标至少 44px。
- 交付检查 390/768/1440 × 双主题、320px 重排、键盘与减少动态效果，并在 VERIFICATION.md 记录真实接口与模拟数据的验证边界。
- 提交 `.design/*.tgz` 与 pnpm 锁文件，不直接修改 node_modules 或共享设计包；缺口先记录，不擅自创建 issue。
