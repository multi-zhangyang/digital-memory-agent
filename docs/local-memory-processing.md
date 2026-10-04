# 本地记忆处理与检索方案

## 选择与边界

处理器运行在独立 Python 进程，使用 CPU 推理；Agent 通过业务工具使用结果。主 Agent 不选择张量形状、分批大小或向量索引。安装时联网下载固定模型，推理时不联网、不继承供应商密钥；文字和照片留在本机。外部视觉描述按显式提交或已启用的入库策略，通过单独的供应商适配调用。产品与职责见 [产品定义](product.md) 和 [架构](architecture.md)。

| 工作 | 当前实现 | 固定版本与许可 |
| --- | --- | --- |
| 中文及多语言文字语义 | [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)，384 维，ONNX int8 | `614241f622f53c4eeff9890bdc4f31cfecc418b3`，MIT |
| 图文检索 | [SigLIP2 base 224](https://huggingface.co/google/siglip2-base-patch16-224)，[ONNX 转换](https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX)，768 维 | 转换版本 `ba1f3b0843f24bc5417d38e19c37b287d719b2f4`，Apache-2.0 |
| 人物出现区域与特征 | OpenCV [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) 与 [SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)，128 维 | OpenCV Zoo `47534e27c9851bb1128ccc0102f1145e27f23f98`，分别为 MIT / Apache-2.0 |
| 本地向量索引 | [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/features/vec0.html) 的原生 `vec0` | npm `0.1.9`，MIT / Apache-2.0 双许可 |

固定清单见 [models.json](../services/memory-worker/models.json)，共 14 个模型、分词器、配置和许可文件，586,774,751 字节。每个文件记录来源、版本、大小和 SHA-256；启动也检查摘要。Python 依赖由 `uv.lock` 固定。当前协议为版本 1、处理器为版本 2，指纹覆盖模型与预处理配置；不混用不同指纹的向量。

选择小型 CPU 编码器，是为了先测清楚独立服务、中文查询、原件关联和更新成本。Qwen3-VL-Embedding / reranker 等可作为后续对照候选；本阶段未部署，不能根据模型卡分数认定它们在个人资料上更好。检索向量也不代表已经训练了个人记忆模型。

## 安装与运行

需要 Python 3.12 或 3.13 与 uv；在项目根目录执行：

```bash
UV_PROJECT_ENVIRONMENT="$PWD/.data/memory-worker/venv" uv sync --project services/memory-worker --frozen
python3 services/memory-worker/setup_models.py --destination .data/memory-worker/models
```

重新启动 Agent 服务后自动发现上述文件。自定义数据目录时可设置 `MEMORY_WORKER_PYTHON` 和 `MEMORY_FEATURE_MODELS`；`MEMORY_LOCAL_FEATURES=off` 禁用本地特征。未安装、启动失败、索引排队和处理失败在个人记忆界面显示真实状态，查询可回退到关键词。没有模型文件时不在后台偷偷下载。

Node 适配层只启动项目内固定脚本，不接受 Agent 提供的命令或路径。进程最多接收 16 个待处理请求，单请求限时 60 秒，协议和结果有大小限制；中止会终止 worker 并拒绝迟到输出。原始异常、stderr 和下载签名链接不进入前端错误。

## 处理与查询

- E5 使用 `query:` / `passage:` 前缀、attention mask 平均池化和 L2 归一化。长记录分为有重叠的片段，超过覆盖上限或分词被截断会报告失败。
- SigLIP2 按固定配置缩放与归一化图像，使用独立文字/视觉 tower。图像相似度只能提供候选，不能当作身份或事实置信度。
- YuNet 使用 320 / 640 / 1280 多尺度检测并合并区域，SFace 对齐人脸后提取特征；最大 1,600 像素预处理边、最小 32 像素人脸、最多 32 个人脸。未检测到不能证明画面中没有人。
- EXIF 的本地拍摄时间和时区偏移保存为素材观察；缺失保持未知，不能用导入时间补齐。只记录 GPS 是否存在，不自动把坐标送入外部请求。

记忆写入在同一数据库事务内排队索引维护。worker 自己取批次、核对当前版本、写入结果并续作，无需主 Agent 在线。旧版本索引即使尚未删除，也必须在 KNN 的候选截断前被版本、空间、时间、人物和来源条件排除。

原件与记忆使用独立作业。`AssetIndexService` 从原始 UTF-8 文本建立分段和 FTS，并通过本地处理器建立 `source_text` 向量；从原图建立图像/人脸特征。`MemoryFeatureService` 同时维护记忆正文索引。没有照片描述或尚未核对也可以查找原图；未配置编码器时保留关键词能力。

`search_evidence` 返回原件与当前素材观察，并标记未核对；`search_memories` 只返回符合确认规则的事实。原件、观察、索引和参数记忆各自有不同含义。索引配置在「设置 → 个人记忆」，作业与实际能力状态在「处理与核对」；旧资料的本地索引重建不授权向外部模型重新上传。

查询组合关键词、文本语义和明确视觉意图的图文召回。各路先取有界候选，以加权倒数排名融合，然后重新核对账本版本；不用不同模型的相似度直接相加作为概率。普通文字问题以文本为主，视觉意图以图片为主，避免同一图片的文字、图像两路重复投票压过经历证据。排序策略属于服务，可独立更换。

人物特征达到当前候选阈值且与次优候选有间隔时，可以减少逐张归组；所得关联仍为 `candidate`，没有真实姓名。用户在「人物 → 照片人物」对照原件确认整组、合并或拆分，保存版本与依据。已确认组后续加入的新出现仍待确认。同名人物保持不同 `personId`。人物表的文字提及计数与照片出现次数分别展示。

## 实际对照及限制

原始视频按相同本地图像编码器建立帧向量与人物出现，默认抽样间隔 10 秒、最多 120 帧；不以生成描述或观察确认作为索引前提。原件、请求及实际帧时间、模型、状态和失败回执随队列持久化。部分失败保留成功帧，重试复用完成工作；修改间隔与模型后按新策略维护。声音不进入该本地索引，片尾按视频轨时长抽样。

视频验证可运行 `python3 examples/videos/download.py` 与 `pnpm --filter @memory/agent eval:video-index`；需要实际 Agent 路径时增加 `--agent`。来源许可与发送范围见 [视频对照说明](../examples/videos/README.md)。独立索引结果见[阶段二十二](plans/0022-video-source-index.md)。按画面提出草稿、确认和实际文件交付可运行 `eval:frame-memory --source-report <已完成的视频索引报告绝对路径>`，使用隔离库和 gpt-6-luna，仅发送公开拼接画面与该库记录；当前结果与质量限制见[阶段二十三](plans/0023-frame-memory-drafts.md)。

纠正后的重建使用 `pnpm --filter @memory/agent eval:dataset:rebuild --source-report <已完成的 frame-memory-live 报告绝对路径>`：从该公开素材归档恢复到新的隔离库，实际用户指令纠正一条、保持另一条，真实 Agent 按原配置重建并交付；核验沿用样本及其审阅版本、生成调用数、文件和恢复结果。结果与语义限制见[阶段二十四](plans/0024-dataset-rebuild.md)。这里不启动个人模型训练。

原始报告保存在忽略目录，不写入 Git：

- `hybrid-real-p3nOTt/report.json` 保留首次融合对照。文字问题中图片候选过度加权，12 题的融合 R@1 为 10/12；读取器结果还暴露了虚构场景说明与未知题评分条件的问题。
- `hybrid-real-fdCU5o/report.json` 为修正后的同组对照：12 条虚构经历，FTS R@1/R@3 为 7/12，E5 和融合均为 12/12；三条中文图像查询 Top-1 均命中。每题同时执行三种检索的中位耗时约 39.18 ms，首次约 1.48 s；融合证据包 2,071–2,107 字节。这不是大规模延迟或准确率保证。
- 三张有许可的肖像均检测到一个对应区域，两张同人肖像进入同一候选组，另一人物分开，身份都保持未知。单独特征审计的同人余弦值约 0.825，不同人约 0.237 / 0.098；阈值没有经过日常个人相册的大样本校准。
- 实际配置的 `gpt-6-luna` 读取器通过 6 个问题，其中两个必须回答未知。原始回答保留供核对；这次测试给了证据，不是个人模型闭卷记忆测试。

修正排序后重测同一固定集具有开发集偏差。还需独立测试生活照片、遮挡/年龄变化、多个相近事件、否定和长尾关系，并报告召回、身份关联错误和读取编造，而不能只看单一命中率。外部视觉描述此前将咖啡杯误判成浅碗，其失败记录仍保留；向量检索成功没有消除视觉描述的误识别。

## 数据集与恢复

`build_dataset` 和 WebUI「数据集」调用同一个服务：冻结全部合格记忆版本 → 逐条核验 → 模板或独立模型生成问题 → 样本核对与导出。模板支持原文叙述和同一明确事件的少量组合；模型生成训练问法及针对相同已知答案的评测问法。清单保存每条输入的状态、排除原因与依赖，不用相关性 Top-K 近似全量。

推断、未解决的不确定性、待审冲突、不可核验来源和完全重复记录不进入可训练样本。用户确认、策略接受、来源未知分别记录；策略接受与模型生成问题需要样本核对。答案必须逐字来自当前确认正文，评测答案应与训练题一致，问法不得重复。这个划分测试同一事实的不同问法，不是未知事实保留集。引句匹配不证明问题语义成立；[阶段十七](plans/0017-dataset-questions.md) 的两处语义错误仍然保留。

导出 `training.jsonl` 仅含可用训练样本，`review.jsonl` 保留待审样本，`manifest.json` 记录全部冻结输入、计数和摘要；模型生成任务另导出 `evaluation.jsonl`，其问法不混入训练。未来训练器读取 `messages`，评测器读取 `question / expectedAnswer`；来源引句及依赖属于核验元数据，不能把旧值拼入训练回答。确认样本保存新版本，再生成导出文件。

来源、人物、实体、事件或记忆版本改变会标记受影响样本和数据集过期；已登记模型版本只标记“受影响”，不会假装权重已被修正。当前真实模型版本表为空。恢复过程中断后继续未完成输入；取消保留已提交结果。下载前重新核验原件和导出摘要。

先停止应用服务，再进行记忆备份；目录参数使用绝对路径：

```bash
pnpm --filter @memory/agent archive:memory backup /资料目录 /新的备份目录
pnpm --filter @memory/agent archive:memory restore /备份目录 /新的恢复目录
```

备份包含 SQLite、原件、已完成的数据集文件和 Pi 会话，逐文件记录摘要。复制期间检测到数据库或文件变更则失败；恢复仅写入新目录，验证清单、文件摘要、数据库完整性和外键。恢复会把项目目录绑定重设到新实例的只读工作区，避免错误指向原实例文件。

这是记忆备份，不包含模型连接密钥、Harness 私密配置、编码器缓存、项目文件或训练权重。完整工作环境应在停服后另行备份这些内容；编码器可从固定清单重新部署。恢复后配置 `MEMORY_DATA_DIR`、重新连接模型，并明确重新打开所需项目。
