# 文档索引

开始新任务时先读[收工交接](plans/2026-10-05-handoff.md)，再按任务查看产品定义和架构。交接记录当前运行状态、验证结果、剩余问题与下一步；历史计划里的“当前”“下一步”指各自记录时点。

| 文档 | 用途 |
| --- | --- |
| [README](../README.md) | 启动、配置、主要任务与能力边界 |
| [收工交接](plans/2026-10-05-handoff.md) | 明天的起点、收尾验证与清理后的恢复位置 |
| [产品定义](product.md) | M1–M6 核心用户任务及 H1 执行可靠性的验收 |
| [架构](architecture.md) | Harness、Pi 适配、业务服务、数据与权限边界 |
| [本地处理方案](local-memory-processing.md) | 编码器部署、检索对照、记忆备份与恢复 |
| [第三方说明](../THIRD_PARTY_NOTICES.md) | 官方组件和依赖的来源、许可及实际适配 |

## 历史实现与验证

阶段记录保留当时结果和限制，当前能力以交接、产品定义及源码为准。旧日志和构建路径属于当时快照，清理后的保留范围见交接。

| 阶段 | 记录 |
| --- | --- |
| 01–10：工作台底座 | [初始工作台](plans/0001-foundation.md)、[模型设置](plans/0002-ui-model-settings.md)、[Agent 工作台](plans/0003-agent-workspace.md)、[通用执行](plans/0004-general-agent.md)、[交互](plans/0005-workbench-experience.md)、[界面重建](plans/0006-workbench-rebuild.md)、[本地项目](plans/0007-local-workspaces.md)、[工作流](plans/0008-workbench-workflows.md)、[记忆核心](plans/0009-memory-core.md)、[AI Elements](plans/0010-ai-elements-runtime.md) |
| 11–17：持续记忆与质量基线 | [持续记忆](plans/0011-continuous-memory.md)、[Colab 准备](plans/0012-colab-cli-preparation.md)、[照片记忆](plans/0013-photo-memory.md)、[检索基础](plans/0014-memory-retrieval-foundation.md)、[工具质量](plans/0015-tool-quality.md)、[照片处理实测](plans/0016-photo-processor.md)、[问题生成实测](plans/0017-dataset-questions.md) |
| 18–23：专用 Harness 与媒体任务 | [Harness 重构](plans/0018-harness-refactor.md)、[Agent first](plans/0019-agent-first-media.md)、[媒体复核](plans/0020-media-review-quality.md)、[视频证据](plans/0021-video-memory.md)、[视频索引](plans/0022-video-source-index.md)、[画面记忆草稿](plans/0023-frame-memory-drafts.md) |
| 24–30：训练资料与真实交付 | [纠正后重建](plans/0024-dataset-rebuild.md)、[成对审阅](plans/0025-evaluation-pairing.md)、[后台核验](plans/0026-dataset-audit.md)、[逐题待核对](plans/0027-dataset-review-queue.md)、[交付收尾](plans/0028-dataset-delivery-completion.md)、[部分交付](plans/0029-partial-dataset-delivery.md)、[原决定与后续依据](plans/0030-sample-follow-up-display.md) |

[工作台设计研究](design/0001-agent-workspace-research.md)保留设计依据。照片误识别、问题生成及审阅依据错误均保留在相应阶段，不因后续重构或界面改进被改写成成功。

## 记录约定

每项变更关联核心任务或 Harness 可靠性，并分别记录实现、配置、运行和效果验证。协议替身、真实模型调用、人工对照与独立评测分别报告。

`AGENTS.md` 只维护长期原则。新增阶段结果写入 `plans/`，当前状态集中更新交接，避免 README、产品定义和架构反复堆叠相同进度。生成构建、隔离测试库和重复缓存按用途清理；原件、私人历史、配置、必要证据与最新完整备份保留。
