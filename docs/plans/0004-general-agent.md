# 第四阶段：先完成通用 Agent 底座

状态：2026-10-03 本阶段范围已实现并通过验证。用户明确要求先补齐通用 Agent，再继续数字记忆核心。既有记忆能力保留；嵌入、人物识别、训练仍后置。

## 审计结论

改造前真实使用 Pi SDK 1.0.0，但只接入模型调用、普通工具循环、基础会话、取消和自动压缩配置。原生 steering、分支、手动压缩、Skills、模板、MCP、工具中间输出、扩展交互未接通；通用文件与执行工具被关闭。业务队列、记忆与结果存储是应用自己的实现，不能计为 Pi 原生能力覆盖。

本次核对安装版本的 SDK、sessions、usage、extensions、MCP 文档。一个关键区别：此版本 CLI 内置 MCP / tool_search / codemode 扩展，但 SDK 不默认加载，需要显式工厂和 bindExtensions。不能凭旧版 Pi 介绍判断没有 MCP。

## 通用底座交付范围

- [x] 项目工作目录、文件树、文件读取/编辑/上传/下载和项目指令。
- [x] Pi 原生 read/edit/write/bash 的受控适配；脚本真实隔离执行、输出流、超时和取消。
- [x] 文件变更审阅、逐文件差异、版本校验与恢复。
- [x] 只读/询问/自动模式，工具开关，前端权限请求与决定记录。
- [x] Exa 搜索与网页读取，前端连接配置和来源。
- [x] 原生 steering / follow-up；独立的持久化任务队列；输入消费状态与停止后保留未处理输入。
- [x] 分支/克隆与历史定位，保留 Pi SessionManager 作为模型上下文权威来源。
- [x] 手动压缩、自动压缩状态、当前上下文详情和导出。
- [x] 公开推理输出、工具中途结果、重试/压缩状态和父子工具关联。
- [x] Skills、提示模板、项目指令的加载与管理；斜杠命令入口。
- [x] 显式加载 Pi MCP 扩展，服务配置/连通性/工具可见性与权限约束。
- [x] 模型连接可新增，配置与本次运行参数分开。
- [x] 工作区改为会话、文件、变更、终端与上下文协同；采用官方 shadcn/ui 与 AI Elements。

## 验收

1. 新项目导入数据，Agent 读文件、编写脚本、在隔离环境运行，产生结果文件，用户能检查差异与恢复。
2. 执行中送入新要求，Pi 在原生安全边界接收；排队任务、刷新和停止不丢记录。
3. 只读拒绝写入；询问模式真正阻塞执行直到前端决定；脚本不能读取项目之外的私人目录。
4. 从历史分支继续、主动压缩、加载 Skill 与 MCP 工具，全部通过真实 Pi 集成验证。
5. 自动测试替身与真实模型调用分别记录。不能以一条成功消息或界面按钮存在代替验收。

## 官方设计依据

- v0 的 [Agent 能力](https://v0.app/docs/agentic-features)、[设计模式](https://v0.app/docs/design-mode)、[项目](https://v0.app/docs/projects)：操作与可运行结果相连，支持就地迭代。
- Codex 的 [变更审阅](https://learn.chatgpt.com/docs/code-review?surface=app)、[Skills](https://learn.chatgpt.com/docs/build-skills)、[命令](https://learn.chatgpt.com/docs/reference/commands)：任务执行、具体变更和继续指导在同一工作环境中。
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[会话](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)、[MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)。

不把终端主题、快捷键、项目授权和模型上下文视为同一层。WebUI 应适配交互含义；操作系统隔离和业务持久化仍由我们的 harness 实现。v0 的部署商业集成、Codex 的云端协同等属于另一个产品范围，不作为本地通用底座的完成依据。


## 验证记录

- 类型检查、生产构建通过；服务端 24 项集成测试通过，浏览器 9 项端到端测试通过。
- 服务端使用真实 Pi：文件与脚本工作流、流式终端、权限拒绝/允许、目录穿越和符号链接拦截、取消进程、steering、follow-up 与停止后保留输入、分支、压缩、Skill/模板展开，以及 HTTP / stdio MCP 的真实协议交互。
- 浏览器经过实际 WebUI、HTTP、SQLite 和 Pi，覆盖新项目导入 CSV、脚本输出、编辑、版本冲突保护、逐文件恢复、分支、刷新后继续审批、原生纠偏；原有资料、记忆、队列、取消、移动端和大文件转发继续通过。
- 独立真实 API：用户提供的 gpt-6-luna，low 思考强度，23 秒完成读取 CSV、生成 sum.py、执行 Python、写出并核验 result.json，结果 total=15，七次工具调用全部成功，两个文件变更落盘。配置默认思考强度已设为 low，前端仍可调整至 max。使用隔离的数据目录。
- 独立真实网络工具：Exa 搜索返回五项结果，公开网页读取成功。用户提供的 Exa 凭据已保存到忽略的私有配置，不进入仓库。

## 当前明确边界

- 这是本地通用 Agent 的已验收基础，不能表述为完整复制 Codex / v0 或 Pi CLI 全部能力。
- 项目使用托管工作目录；文件审阅提供逐文件前后内容和回退，尚不提供 Git 暂存区、提交或逐 hunk 接受/拒绝。
- bubblewrap 默认无网络；显式启用主机网络会允许接触网络和本机服务。未实现容器配额、硬盘配额或不可信用户多租户托管。
- MCP 支持 HTTP 静态请求头与 stdio。本地 MCP 的项目挂载只读；未适配 OAuth、任意 TUI 自定义组件、扩展包市场和 codemode。
- Skills、模板和项目指令可以管理，不会自动执行未知项目中的扩展代码。现有会话中的根 AGENTS.md 在新建运行时后重新加载。
- 压缩与会话恢复不是长期记忆；人物识别、嵌入检索、小模型训练仍后置。

生产服务已启动在本机 3000 / 4310 端口；生产浏览器检查无页面错误，确认模型上下文 256,000、沙箱可用、Exa 已配置。
