# 阶段十：统一 Agent 运行组件与首次发布源码

> 历史阶段记录：保留当时的决策、实测和限制。当前产品以 [产品定义](../product.md)、[架构](../architecture.md) 和 [Harness 重构计划](0018-harness-refactor.md) 为准。

## 目标

按用户指定的 [AI Elements](https://elements.ai-sdk.dev/) 统一 Agent 运行界面，安装用户级 skill，并将已经完成的工作台与文字记忆核心提交到用户建立的 GitHub 仓库。

## 组件接入

| 交互                           | AI Elements 组件                                                              |
| ------------------------------ | ----------------------------------------------------------------------------- |
| 当前与恢复的对话、空状态       | Conversation、Message、MessageResponse                                        |
| 思考、执行汇总与步骤           | Reasoning、ChainOfThought、Plan、Task                                         |
| 工具参数、结果与失败           | Tool、ToolInput、ToolOutput、CodeBlock                                        |
| 执行许可及接受/拒绝记录        | Confirmation、ConfirmationRequest、ConfirmationAccepted、ConfirmationRejected |
| 主输入与等待用户补充           | PromptInput、Suggestions                                                      |
| 排队请求与执行中指令           | Queue                                                                         |
| 附件、网络来源、原文引用与结果 | Attachments、Sources、Artifact                                                |
| 模型、上下文与终端输出         | ModelSelector、Context、Terminal                                              |
| 运行完成后的文件改动与审阅入口 | Task、CheckpointTrigger                                                       |
| 经历导入任务、分段状态与错误   | Task、Tool、ToolOutput                                                        |

组件由 Pi/Harness 的真实事件和已存状态驱动，不引入第二套模型调用循环。工具失败默认展开，审批结果随执行保留，补充回答失败时保留文本。业务导航、数据列表、设置、编辑器与对比视图继续使用 shadcn/ui 和现有专用组件。

代码预览按需加载；纯文本和大文件通过 CodeBlock 的文本路径直接显示，不逐行进行语法高亮。组件来源与本地适配在 [第三方说明](../../THIRD_PARTY_NOTICES.md) 中记录，未新增独立视觉样式表。

## 用户级 skill

执行用户指定的安装命令，并显式选择全局与 Codex：

```bash
npx --yes skills add vercel/ai-elements --global --agent codex --yes
```

安装位置为 `~/.agents/skills/ai-elements`；`~/.codex/skills/ai-elements` 链接到同一份安装。`skills list --global --agent codex --json` 已验证 scope 为 global。skill 不存放在项目内，也不随项目源码提交。当前开发已读取 SKILL.md 及相关组件文档，后续会话可以继续使用。

## 验证与提交

- `pnpm typecheck` 与 `pnpm build` 通过。完整生产模式浏览器回归 **24 项通过**，涵盖实际工具参数/终端输出、审批及刷新后的结果、思考、流式输入、纠偏/队列、项目文件与审阅、文字记忆导入与冲突修订、移动端及失败恢复。
- 新增的补充回答检查覆盖中文输入法确认键不提交、发送失败保留草稿、重试后恢复工具与刷新保留回答。网络失败仅在该测试请求中模拟，不改动生产传输。
- 文字记忆核心的后端 **41 项测试**与真实模型检查已通过，细节见 [第九阶段](0009-memory-core.md)。本阶段前端回归使用本地模型替身，Pi、数据库、文件和权限仍实际执行。
- 桌面执行记录、手机补充回答和记忆时间线截图已检查；类型、运行状态、折叠与附件使用官方组件。没有新增项目级 skill、模型依赖或独立视觉样式表。
- 本机生产服务运行于 WebUI `http://localhost:3002` 和 Agent `http://127.0.0.1:4310`，健康检查及记忆概览接口均返回 200。3000 端口已被其他站点使用，本次通过 `PORT=3002` 与对应的 `MEMORY_ALLOWED_ORIGINS` 启动，仓库默认端口仍为 3000。
- 源码与已配置模型、Exa 的真实密钥做精确比对，未发现凭据匹配。私人数据、构建产物、浏览器记录和用户级 skill 均不进入提交。
- 首次提交覆盖通用工作台、文字记忆核心与 AI Elements 统一接入；远端为用户建立的 [multi-zhangyang/digital-memory-agent](https://github.com/multi-zhangyang/digital-memory-agent)，分支 `main`。作者为当前已登录 GitHub 用户 `zhang yang`（`multi-zhangyang`），采用该账号的 GitHub noreply 邮箱。
