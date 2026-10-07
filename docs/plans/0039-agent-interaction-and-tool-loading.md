# 0039：Agent 交互与按需工具

2026-10-07。本轮处理查询与保存、工具呈现、流式阅读、展开滚动和页面响应。用户已确认当前 UI 可以，本阶段收尾。后续开发以核心记忆任务为主；个人模型训练仍暂停。

## 一手调研与取舍

| 参考 | 已核对的实现或官方说明 | 本项目采用 |
| --- | --- | --- |
| [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md) | 模型、工具注册、会话与 Agent loop 均以插件组合；持久 SessionEvent 与实时 Agent 事件分工。Web 保留流式基线供重连，回合过程有独立展示模型。 | 保持业务服务、Pi 适配与展示分层，继续使用现有持久事件和重连，不为改界面迁移执行内核。 |
| [Codex App Server](https://developers.openai.com/codex/app-server) / [Desktop 功能](https://developers.openai.com/codex/app/features) | 线程、回合与 item 生命周期分开；item/started、正文/命令增量、item/completed 共用稳定标识；项目、线程和结果审阅是不同工作区域。 | 使用真实 Pi 消息和 toolCallId 原位更新，保留工作区与来源查看，避免完成时重新创建工具卡片。未假定闭源 Desktop 的具体动画实现。 |
| [Claude 工具发现](https://www.anthropic.com/engineering/advanced-tool-use) / [Claude Code ToolSearch](https://code.claude.com/docs/en/tools-reference) | 常用工具直接提供，其余定义发现后加载；技能和工具定义不需要全部常驻。 | 使用已安装 Pi 的 deferred/tool_search，跨模型供应商工作，不引入 Claude 专属 API。 |
| [T3 Code WorkLog](https://github.com/pingdotgg/t3code/blob/611132c171f3a821bd2e32f22261135cef6330ac/apps/web/src/components/chat/WorkLog.tsx) / [Markdown](https://github.com/pingdotgg/t3code/blob/611132c171f3a821bd2e32f22261135cef6330ac/apps/web/src/components/ChatMarkdown.tsx) | 紧凑一致的执行行，摘要与展开详情分开；Markdown 在流式状态切换时保持组件类型稳定。 | 缩短工具行间距、去掉详情外层重复边框和重复标题；沿用 AI Elements，不复制 T3 控件。 |
| [Pi Web 展开状态](https://github.com/agegr/pi-web/blob/17bbadb428227098b2281574b14457f49c4752de/lib/tool-call-expansion.ts) / [阶段状态](https://github.com/agegr/pi-web/blob/17bbadb428227098b2281574b14457f49c4752de/lib/chat-phase-label.ts) | 用户展开选择按工具标识保留；等待模型、运行工具、压缩分别显示。 | 现有稳定挂载可保留本地展开状态，不另建全局缓存；以真实阶段与可见内容维持等待提示。 |
| [Pi 工具暴露](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#tool-exposure) | 本机安装的 1.0.0 已支持 deferred、hidden、tool_search 与分支工具集合持久化。原生 BM25 tokenizer 只支持英文与标识符。 | 直接接入现有机制，模型使用英文能力词或工具名发现；没有另写路由 Agent 或搜索引擎。 |

布局同时参考 [Linear 的界面更新](https://linear.app/now/behind-the-latest-design-refresh)和 [Vercel v0](https://vercel.com/blog/introducing-the-new-v0-api)：突出用户任务，统一导航与阅读层级，以官方组件组合实现。

公开网页、源码快照与截图留在忽略目录 `.data/design-research/0039-interaction/`，未将参考项目作为产品依赖或执行其安装脚本。

## 最终实现

### Agent 与工具加载

原先 35 个内置工具直接向模型提供完整定义；现在默认常驻 `read`、`ask_user`、`search_memories`、`search_evidence`、`read_evidence`，加 Pi 原生 `tool_search` 共 6 个，其余 30 个按需发现。禁用工具不进入发现，MCP 沿用用户的 direct/deferred 配置。

新用户任务恢复初始工具集合，审批恢复、后台通知和同任务继续执行保留已发现能力。Pi 注册但本项目未启用的原生工具不会被重新激活。执行权限仍在原有边界实施。

常驻产品规则精简为目标、查询路径和基本边界，详细操作放入可覆盖的四类 Skills，不再按关键词注入整套细则。项目文件与资料库原件明确区分，已选资料可直接读取，保存已有结果无需重新处理或扫描项目目录。

### 会话与工作区

保留会话居中的布局，突出整理生活、查找与回忆、纠正记忆，上传在输入栏，运行参数集中到任务设置。compact、会话树、工具/Skills/MCP、执行中调整与队列都有入口。文件、成果和证据按需展开工作区；桌面分栏稳定挂载，1100px 以下通过 Sheet 查看。

正文默认使用 Streamdown 原生增量动画，150ms 淡入、不增加逐字延迟；结束与历史内容不保留动画包装。MessageResponse 的 memo 比较纳入流式状态。文字与工具参数沿用 50ms 合并，生命周期和审批及时显示；空消息标识不再造成等待提示消失或空白占位。

工具以固定摘要行原位更新，思考与工具详情默认收起，手动展开及参数/结果页签保持，结束不自动折叠。收起时仍显示错误摘要。详情沿用 Collapsible 高度过渡，后台陈述提取明确显示为“自动记录”。

展开、收起和切换详情页签前调用官方 `stopScroll`；动态 CodeBlock 使用局部 Skeleton，避免首次加载挂起上层消息。修复前，合成长会话中展开思考会自动滚动约 430px，首次代码加载还会使会话高度先缩小再恢复；两处原因分别处理。继续使用官方 Conversation 与回到底部入口。

### 页面响应

React Activity 保留访问过的页面、草稿、筛选和未保存输入，隐藏时暂停 effects。常用页面在空闲时间依次预加载代码，数据访问时读取。导航使用 transition 与共享 Suspense，侧栏先反馈选择，当前内容保留到新页面就绪；移除整页重复淡入。

命令面板直接加载，文件选择和审批代码详情有局部加载边界。会话控制保持挂载，只在版本变化或主动打开时读取；已完成审批和自动记录切页不重复请求，运行中照常刷新。已有记忆记录的初次展示不再触发整个工作台的数据重读。

## 验证结果

### 协议与浏览器

类型检查、前后端生产构建通过。真实 Pi、文件、权限和会话链路验证了工具发现、新任务收回定义、MCP、审批恢复、脚本输出与停止；这些集成检查的模型为协议替身。

针对性浏览器流程分批通过：正文与思考流式、结束后动画清除、工具执行完成保留展开和页签、失败摘要、SSE 重连、队列、长历史分页、草稿与筛选、未保存模型输入、Pi 压缩与刷新恢复、审批和执行中追加指令。返回长会话不再重发 60 条历史审批请求。

展开滚动使用合成长会话，在 1280px / 390px 覆盖展开、收起、首次代码加载和参数/结果切换：会话 scrollTop 与触发器位置变化不超过 1px，window.scrollY 不变。启用后的 1440px / 390px 页面无运行异常或横向溢出，减少动画偏好检查通过。

压缩曾因短会话未达到 Pi 保留阈值返回 `NOTHING_TO_COMPACT`，改用足够长的会话后成功；减少动画样式修复后复测通过。将 API 时间线快照也放入 transition 的尝试出现 SSE 订阅问题，已撤销，不属于最终实现。

### 真实模型

已配置的 `gpt-6-luna` 在隔离库执行查询测试野餐、保存结果两轮任务，约 10.3s / 15.9s，均 completed、无工具错误。查询通过一次 `read_evidence` 完成；保存通过 Skill、原件读取、工具发现与 `write_artifact` 交付带来源文件。

首次试跑存在多余目录读取和错误来源名；调整能力说明与原件入口后再次通过，原失败报告保留。该样例不代表普遍性能、视觉准确率、活动归组或训练质量提升。日常整理与纠正的真实流程见[0037](0037-daily-memory-and-pi-controls.md)。

### 本机响应测量

同机 Chromium、1440×900、4 倍 CPU 减速，同一会话连续三轮导航：

| 操作 | 改动前 | 改动后 |
| --- | --- | --- |
| 首次进入记忆 | 500ms | 259ms |
| 首次进入资料库 | 442ms | 183ms |
| 首次进入设置 | 463ms | 196ms |
| 返回会话，点击至双帧回调 | 106–144ms | 30–37ms |

这是本地自动操作样本，包含定位开销，不代表所有设备、大资料库或模型响应速度。测量、截图和调研材料保存在忽略目录 `.data/design-research/0039-interaction/`，包括 `responsiveness-before.json`、`responsiveness-after.json` 与 `responsive-mobile.png`；运行资料不进入 Git。

## 本机运行快照

本阶段启用的生产 Web 为 `http://127.0.0.1:3002`，使用 `apps/web/.next-responsive`；Agent 为 `http://127.0.0.1:4313`，产品规则版本 16。进程和日志路径以本机 `/home/dev/.local/state/digital-memory/living-memory-current.json` 为准。以上是本机快照，通用启动端口见根 README。

测试资料留在隔离库，未写入日常资料库。此次文档收尾删除被后续实现替代的工作台计划、旧交接和重复设计稿；当前使用与架构集中维护，有复现价值的模型对照和已知质量问题仍保留。
