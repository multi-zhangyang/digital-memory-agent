# 文档索引

从 [项目 README](../README.md) 开始启动和配置。日常使用看产品与服务说明；开发看架构与接入协议；近期改动和实测结果分别列在下方。

## 当前文档

| 文档 | 内容 |
| --- | --- |
| [产品定义](product.md) | 核心用户任务、工作台使用方式与能力边界 |
| [架构](architecture.md) | Harness、Pi、业务服务、前端与数据职责 |
| [特征服务、检索与恢复](local-memory-processing.md) | 用户配置模型服务、索引版本、备份与恢复 |
| [特征服务接入协议](feature-service-protocol.md) | OpenAI 嵌入接口与 Memory Features v1 |
| [评测复现](../examples/quality/README.md) | 固定材料、独立环境与运行命令 |
| [第三方说明](../THIRD_PARTY_NOTICES.md) | 依赖来源、许可与组件适配 |

## 最近阶段

| 记录 | 内容 |
| --- | --- |
| [0039：Agent 交互与按需工具](plans/0039-agent-interaction-and-tool-loading.md) | 本轮 UI 收尾；工具发现、流式、滚动、切页及本机运行 |
| [0037：日常记忆与 Pi 操作](plans/0037-daily-memory-and-pi-controls.md) | 活动整理与追加、跨会话回忆、纠正、compact 和会话控制 |

## 模型选型实测

模型由用户配置，以下对照用于选型和复现，不是产品默认配置。

| 记录 | 内容 |
| --- | --- |
| [0035：统一嵌入](plans/0035-unified-embedding-evaluation.md) | EmbeddingGemma 2 与 E5＋SigLIP2 的 CPU/GPU 对照 |
| [0036：人脸 GPU](plans/0036-face-gpu-evaluation.md) | SCRFD＋ArcFace、GPU 共同驻留与迁移限制 |

## 历史实现与验证

仅保留仍用于解释质量问题和复现实验的记录。表中的模型、路径与结果均属于当时实测，不代表当前默认能力。

| 记录 | 保留原因 |
| --- | --- |
| [0015：工具质量](plans/0015-tool-quality.md) | 检索、读取与视觉错误的基线 |
| [0016：照片处理](plans/0016-photo-processor.md) | 新图对照、未采用的提示方案和误识别 |
| [0017：训练题生成](plans/0017-dataset-questions.md) | 题目语义错误与生成边界 |
| [0020：媒体复核](plans/0020-media-review-quality.md) | 原件局部核对、真实失败与恢复结果 |
| [0031：来源作答](plans/0031-dataset-answerability.md) | 训练评测配对、核验错误与调用成本 |

## 维护方式

`AGENTS.md` 只维护长期原则；产品定义写用户任务，架构写模块职责，阶段记录写变更和实测。实现、配置、运行状态和效果分别说明。过时计划、重复说明和旧交接直接删除，历史可从 Git 查阅；保留有复现价值的结果，不另建文档归档堆积。
