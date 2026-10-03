# 工作台重构

本阶段重新组织通用 Agent 的操作界面。数字记忆训练、向量模型与人物识别继续后置。

## 依据

通过 Exa 检索并核对官方页面与组件注册表：

- [Synara](https://www.trysynara.com/)、[核心概念](https://www.trysynara.com/docs/getting-started/core-concepts)：以实际深色产品截图对照侧栏、对话、输入和环境面板，任务承载会话、工具与文件变更，面板按需打开。
- [T3 Code](https://t3.codes/)、[源码](https://github.com/pingdotgg/t3code)：对照实际工作台截图与侧栏、输入组件，参考轻量执行记录、持续可见的回复、文件交付与并排审阅。
- [Pi Web](https://pi-web.dev/)、[源码](https://github.com/jmfederico/pi-web)：参考持久化会话、工作区、文件和终端的组织方式。
- [shadcn Sidebar Blocks](https://ui.shadcn.com/blocks/sidebar)：采用官方 Sidebar 与基础控件组成单侧栏，统一导航、项目选择和任务列表。
- [AI Elements Chatbot](https://elements.ai-sdk.dev/examples/chatbot)、[Prompt Input](https://elements.ai-sdk.dev/components/prompt-input)：对话、输入、附件与模型选择使用官方组件。
- [Vercel Agent Chat](https://vercel.com/docs/agent/chat)、[v0 Projects](https://v0.app/docs/projects)：项目上下文、任务历史、附件、执行可见性与授权应组成连续流程。
- [Claude Code Permissions](https://code.claude.com/docs/en/permissions)：将权限选择与实际执行边界对应，不提供只有名称的模式。
- [Pierre Diffs](https://diffs.com/docs) 与 [jsdiff](https://github.com/kpdecker/jsdiff)：使用现成的 React 差异审阅组件展示行号、逐行与并排对比，通过实际快照生成可下载的补丁。

这些参考用于形成适合本项目的交互方案，不表示各产品存在同一套正式 UI 标准。通过 Exa 查找原始项目，再直接核对官网截图、文档和相关源码。检索回执与参考截图保存在被 Git 忽略的 `.data/design-research/0006/`，外部产品截图不作为本项目的界面素材。

## 实施范围

- 单侧栏集中应用、项目与任务导航；48 px 页头、独立滚动的对话和按需展开的审阅区，保持桌面与移动端的操作对应。
- 新任务入口专注输入，完整任务列表独立管理；可搜索、筛选进行中的任务、查看归档、收藏、恢复归档与管理任务。
- 使用 AI Elements Model Selector、Prompt Input、Message、Chain of Thought、Confirmation，重新组合对话、模型参数、附件、执行记录和审批。
- 文件、改动、终端使用统一审阅面板；保持真实文件编辑、冲突检测、回退和会话控制。
- 模型与 Agent 设置重排，资料与结果页面沿用同一布局语言。
- 保留 Pi 会话、原生纠偏与后续指令、队列、停止、重试、分支、SSE 恢复和前端密钥保护。
- 保留草稿隔离、流式批处理、历史缓存、渐进呈现和重组件延迟加载。

## 完成的交互

| 工作流     | 实现                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目与任务 | 单侧栏保留项目选择、进行中的任务、收藏和最近记录；完整列表在「所有任务」，搜索、分页和归档恢复均读取真实数据。                                                                |
| 输入与模型 | AI Elements Prompt Input 与 Model Selector，支持按供应商搜索模型、设置思考强度与权限、文件拖放/粘贴、资料选择、命令和 Skills。停用或移除的模型不会继续作为隐藏的提交值。      |
| Agent 执行 | 思考、计划和工具集中到轻量 Chain of Thought；运行时展开，结束后收起，手动展开状态保留。去掉重复的品牌标题和状态卡片。需要审批的操作始终可见，使用 Confirmation 执行真实授权。 |
| 交付与审阅 | AI Elements Artifact 连接真实结果；回复附带可展开的真实文件清单，点击文件直接定位到对应轮次与差异。Pierre Diffs 提供逐行和并排审阅、修改前后版本与补丁导出。                  |
| 文件编辑   | 语法高亮预览、哈希冲突检测、取消、快捷键保存。按项目保留当前标签页中的未保存缓冲，关闭面板再打开不会丢失；刷新前提示，不存储文件正文到 localStorage。                         |
| 设置与资料 | 模型连接按 Accordion 展开，模型与 Agent 配置独立；资料、记忆、结果页统一标题、宽度、工具栏和空状态。                                                                          |
| 移动端     | 官方 Sheet 提供侧栏和审阅面板；模型、权限、运行控制和附件操作保持可用。                                                                                                       |

布局和业务组件位于 `workbench-navigation.tsx`、`task-launcher.tsx`、`task-library.tsx`、`workbench-composer.tsx`、`run-thread.tsx` 和 `project-workspace.tsx`。删除旧的 `workbench-home.tsx`，结果库独立为 `artifact-library.tsx`。没有添加视觉 CSS 文件，继续使用官方中性色令牌、基础控件与库内样式。对话输入框采用更紧凑的尺寸；侧栏展开状态由用户控制，切换页面不自动改变宽度。

Pi 仍负责模型、原生工具与会话执行。此阶段没有替换为 AI SDK Agent 后端；AI Elements 用于呈现现有 Pi 状态。原有纠偏、follow-up、排队、审批、停止、重试、分支、会话导出、上下文压缩与断线恢复继续保留。

保留 50 ms 流式批处理、草稿独立订阅、按需加载、20 轮初始呈现与历史缓存。差异计算设置时间、编辑距离与内容大小上限，超限可查看前后版本。差异渲染的缓存标识包含文件路径与前后版本哈希，切换轮次会更新内容。修复高亮缓存对等长文件中部编辑返回旧内容的问题，并处理高亮完成早于订阅注册时的更新。

## 验证记录

浏览器测试在独立数据目录运行。供应商响应使用本地测试传输；Pi、数据库、文件读写、执行沙箱、审批和 SSE 使用实际实现。本轮不消耗真实模型 API 配额，也不将个人资料用于测试。

- `pnpm typecheck`、`pnpm build` 通过。
- `pnpm test`：24 项后端测试通过；本轮未修改后端执行实现。
- `E2E_PRODUCTION=1 pnpm test:e2e`：15 项浏览器测试全部通过。
- 新增验证包括 26 个真实任务的搜索/分页/归档恢复/收藏、模型与思考/权限参数的实际提交、剪贴板文件上传、历史轮次定位、点击交付文件直接审阅、逐行/并排切换与补丁内容、等长文本修改后的高亮更新、关闭面板后的编辑恢复。
- 移动端验证包含长任务标题、审批等待时的停止与工作区入口、实际批准写入，以及原有资料和记忆操作。
- 原有 100 段流式输出、SSE 重连、Pi follow-up、原生纠偏、排队停止、历史缓存与草稿恢复均回归通过。

最终生产构建，本机 Chromium、1440 × 1000 的合成观测：

| 观测项                        |  新任务页 |    60 轮历史场景 |
| ----------------------------- | --------: | ---------------: |
| 首次加载脚本解码体积          | 820,031 B |      1,434,590 B |
| 输入到下一帧中位数            |   15.4 ms |          15.5 ms |
| 输入到下一帧 P95              |   15.8 ms |          31.0 ms |
| 首次呈现的运行记录            |         0 | 20，其余按需展开 |
| 启动时超过 50 ms 的主线程任务 |        无 |     1 次，127 ms |

以上为 40 次按键采样，受设备和负载影响，不是用户现场 INP，也不表示首次加载长会话已完全消除主线程阻塞。字节数为解码后的脚本体积，不是压缩网络传输量。差异库与高亮仍按需加载。

复现：生产服务启动后执行 `node tests/bench/workbench.mjs rebuild http://localhost:3000`。结果与截图在被 Git 忽略的 `test-results/performance/rebuild/`；浏览器回归截图在 `test-results/`。不将测试任务或示例记忆写入用户数据目录。
