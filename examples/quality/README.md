# 独立工具质量评测

这组固定材料用于检查精确编号、相近事件、纠正、日期、人物歧义、图像检索和视觉描述，不代表用户经历或个人参数记忆。开发题与保留题分别报告，修正固定后才运行保留题；如果保留题后来用于诊断或调参，后续结果必须改记为开发回归，不能继续称为独立保留评测。

以下模型和固定清单仅用于可复现评测，不是产品默认配置。实际使用在设置页接入用户自己的服务，见[特征服务说明](../../docs/local-memory-processing.md)。

## E5＋SigLIP2 与 EmbeddingGemma 2 对照

使用已校验的 `retrieval.json`、`images.json` 和 `.data/quality-fixtures/`，直接比较真实编码器的排名。所有题搜索全部候选，包含修正后的正文；这是编码器回归，不应用产品的关键词、时间、人物过滤，也不验证回答或人脸。历史保留题已可见，不再作为盲评。完整配置、实测和限制见[统一嵌入评估](../../docs/plans/0035-unified-embedding-evaluation.md)。

候选的固定版本为 `google/embeddinggemma-2@914f7f89142e33e77833254d9c9b90c3cef7303b`，仅加载文字与视觉，使用 768 维向量和官方检索提示。独立 CPU 环境不修改现有 worker：

```bash
UV_PROJECT_ENVIRONMENT="$PWD/.data/memory-worker/embeddinggemma2-eval-venv" uv sync --project examples/quality/embedding-environment --frozen
python3 examples/quality/download-embeddinggemma2.py --destination .data/memory-worker/embeddinggemma2-eval/model

.data/memory-worker/venv/bin/python examples/quality/evaluate-embedding-backends.py --backend legacy --device cpu --models .data/memory-worker/models
.data/memory-worker/embeddinggemma2-eval-venv/bin/python examples/quality/evaluate-embedding-backends.py --backend embeddinggemma2 --device cpu --models .data/memory-worker/embeddinggemma2-eval/model
```

只有下载步骤联网获取公共权重；运行时仅加载本地模型与固定样例。每次生成独立的 `.data/evaluations/embedding-*` 目录，保存 `report.json` 与 `vectors.npz`。候选同时报告文字、图像和同一个查询空间下的混合检索。命中率分母排除无答案和身份歧义题；查询耗时包含分词、编码与归一化，不含数据库检索。图像计时不含人脸推理。模型与图片的原件、向量和运行输出不进入 Git。

安装 FFmpeg 并准备 `examples/videos/download.py` 的固定公开视频后，给任一评测命令添加 `--video-only`，可单独检查两段视频的六个抽样帧。四个中文场景问题在 `embedding-video-queries.json` 中固定；报告保存帧与来源摘要，不评估完整视频的动作或音频理解。

GPU 对照使用单独的 Linux x86_64 / CUDA 12.8 环境，适配本机已有驱动。CPU 与 GPU 依赖各自锁定，运行时报告实际版本与精度：

```bash
UV_PROJECT_ENVIRONMENT="$PWD/.data/memory-worker/embeddinggemma2-gpu-venv" uv sync --project examples/quality/embedding-gpu-environment --frozen
.data/memory-worker/embeddinggemma2-gpu-venv/bin/python examples/quality/evaluate-embedding-backends.py --backend embeddinggemma2 --device cuda --models .data/memory-worker/embeddinggemma2-eval/model
```

GPU 锁文件中的 PyTorch wheel 使用同一官方站点的 `download.pytorch.org` 下载地址，内容摘要与上游锁定文件一致；本机访问其 `download-r2.pytorch.org` 地址曾返回 403。GPU 实测状态与资源占用以阶段报告为准。

## 人脸 GPU 替换评估

`evaluate-face-backends.py` 比较旧版 worker 的 YuNet/SFace CPU 路径与
SCRFD-2.5GF / SCRFD-10GF＋同一 ArcFace R50。权重、官方推理适配代码及许可
固定在 `face-models.json`，仅下载到忽略目录。GPU 环境固定 ONNX Runtime
1.24.4 与 CUDA 12 库，避免自动选择要求更新驱动的 CUDA 13 版本。

```bash
python3 examples/quality/download-face-models.py
UV_PROJECT_ENVIRONMENT="$PWD/.data/memory-worker/face-gpu-venv" uv sync --project examples/quality/face-gpu-environment --frozen
.data/memory-worker/venv/bin/python examples/quality/evaluate-face-backends.py --backend legacy --device cpu
.data/memory-worker/face-gpu-venv/bin/python examples/quality/evaluate-face-backends.py --backend scrfd-2.5g --device cuda
.data/memory-worker/face-gpu-venv/bin/python examples/quality/evaluate-face-backends.py --backend scrfd-10g --device cuda
```

评测实际使用已下载的 18 张公开照片。另对 8 张肖像执行固定缩小至最长边
160 像素、亮度乘 0.25、两者组合的压力测试；这些是原图的派生版本，
不能视为独立困难场景。两个候选使用同一检测阈值 0.5、NMS 0.4、640 输入，
均保留最大边 1600、最小可用脸 32 像素及最多 32 脸的业务约束。

GPU 初始化失败会报错；预热期间记录实际计算节点的 execution provider，
结束 profiling 后才计时。耗时含缩放、检测、对齐及特征提取，不含图片解码和
模型加载。显存为定时采样的整卡占用，不等于精确的单进程瞬时峰值。
同人/异人评分使用匿名参考组，不向模型提供人物姓名或来源说明。
候选匹配阈值只由原开发配对确定，历史保留题仅作回归；这个小样本阈值不能
直接进入正式人物关联规则。压力测试的匹配图库排除同一张来源照片，
按不同人物计算次优差值，不把原图和它的缩小版本当作跨照片识别成功。

准备好上一节的 EmbeddingGemma 2 GPU 环境后，可检查两个候选系统同时驻留：

```bash
.data/memory-worker/embeddinggemma2-gpu-venv/bin/python examples/quality/evaluate-gpu-co-residency.py
```

该检查在两个进程中保留 GPU 模型，交替执行图片编码与人脸处理；它验证小批量
串行任务的显存可行性，不等于并发服务压测。正式 worker、资料库和人物确认
不被这些脚本修改。实测结果及正式迁移条件见[阶段三十六](../../docs/plans/0036-face-gpu-evaluation.md)。

## 原有工具质量评测

`retrieval.json` 包含 41 条虚构记录、20 道开发题和 12 道保留题。确认状态仅为测试设定；查询证据关联当前记忆版本及原文范围。未知问题检查回答是否有依据，不要求向量检索返回空结果。

`images.json` 固定 18 张公开照片：8 张物体照片、8 张独立肖像和两张合影。每张记录来源页、原件地址、作者、许可、字节数、SHA-256、尺寸与变换说明；署名及许可应按清单随材料保留。肖像只使用匿名参考组 `a`—`d` 评分，合影不提供位置到姓名的标签。不同肖像的服装、姿态和环境经过原图核对，不把裁切或颜色变换算作更多独立拍摄。

原图只下载到忽略的 `.data/quality-fixtures/`。处理器只收到中性文件名、当前任务文字或图片字节，不读取清单中的人物姓名、来源描述或评分项。评测数据库、向量、原始模型输出和逐项核对记录保存在 `.data/evaluations/`，不进入实际用户记忆库，也不启动训练。

在仓库根目录执行：

```bash
# 使用固定本地 CPU 编码器；下载器遇到限流会保存等待时间并停止，之后可续传。
python3 examples/quality/download.py
pnpm --filter @memory/agent eval:quality:text --split development --label current
pnpm --filter @memory/agent eval:quality:images --split development --label current

# --reader 和 --vision 显式调用已配置的真实外部模型。
pnpm --filter @memory/agent eval:quality:text --split development --label current --reader
pnpm --filter @memory/agent eval:quality:images --split development --label current --vision

# 固定实现后才验收保留题。--vision-id 可限定一张图片，不是追加独立样本。
pnpm --filter @memory/agent eval:quality:text --split holdout --label current --reader
pnpm --filter @memory/agent eval:quality:images --split holdout --label current --vision
```

`--image-detail high` 仅用于隔离实验，通过上游 Pi 的请求钩子指定图像细节，不改变正式处理器。当前实验没有消除识别错误。请求记录只保留图片摘要及大小；摘要一致仅验证客户端提交对应图片，不证明兼容网关的上游实现。

关键词/引用自动检查不等于内容正确。视觉结果必须对照原图分别记录正确观察、遗漏、明确错误和无法核对；人脸数量正确后仍需核对定位。实际结果、剩余错误和验证范围见[阶段十五](../../docs/plans/0015-tool-quality.md)。

`photo-processing.json` 另含六张许可明确的新图及模型输出前固定的像素核对项，只评测照片处理器，不运行主 Agent、索引、个人资料入库或训练。在仓库根目录执行：

```bash
python3 examples/quality/download.py --manifest examples/quality/photo-processing.json --directory .data/quality-stage16-fixtures
pnpm --filter @memory/agent eval:quality:photos --label current
```

报告保存实际模型、协议、提取版本、清单与代码摘要、图片传输摘要、原始计量和逐图输出。计量包含 Pi 分开的输入、缓存读取与缓存写入；输入字段小不代表图片没有传入。新图对照及未采用的短提示见[阶段十六](../../docs/plans/0016-photo-processor.md)。

`dataset-questions.json` 包含六条虚构开发记录及预先固定的核对项，覆盖交接方向、不同日期、历史状态、否定、未知日期和人物关系。运行 `pnpm --filter @memory/agent eval:dataset:questions` 会用已配置连接在隔离数据库中实际生成问题，`--model` 可指定一个已配置模型。报告保留逐题输出、来源版本、调用计量与代码摘要；所有题保持待核对。修正前后的同组运行只作开发回归，不作为独立保留集准确率，也不启动训练。

`dataset-answerability.json` 固定六条开发来源和六条原保留来源，各含两道训练题和一道评测题，植入错误人物、错误日期、未知前提、泄题及同答案不同事实的配对。`dataset-answerability-confirmation.json` 另有四条后续对照来源。此评估器使用固定问题生成替身，只有来源作答和样本审阅调用真实模型；参考答案与风险标签不会发给模型。

```bash
pnpm --filter @memory/agent eval:dataset:answerability --split development --label current
pnpm --filter @memory/agent eval:dataset:answerability --split holdout --label regression
pnpm --filter @memory/agent eval:dataset:answerability --split confirmation --manifest dataset-answerability-confirmation.json --label current
```

命令读取已有供应商配置，可用 `--model` 选择已配置模型，`--case` 限定来源；会产生实际外部调用。每次新建隔离库，保存原始问答、调用、拒绝、实际文件和计量，语义对照初始标为 pending。原保留材料已用于修复引用抄写问题，后续材料也对开发者可见，均不得称为盲评。最终语义须对照实际题干和配对，不能只按原参考答案或 ready 数计准确率；历史结果与限制见[阶段 31](../../docs/plans/0031-dataset-answerability.md)。

`media-review.json` 与 `archive-label.svg` 用于主 Agent 的原件局部复核、日期修复和连续任务验证。公开室内照片保留 CC0 来源和摘要，标签是程序绘制的确定性材料。评估器显式预置错误草稿，并在真实生成问题后删除一处日期，检验恢复过程；这些注入不冒充模型自然错误。三批新文字检验偏好采用、纠正及重启后持续使用。读取、修订和交付由真实 Pi/模型完成，评估器不代为审核，原始失败与独立像素核对均保留。

```bash
python3 examples/quality/download.py --manifest examples/quality/media-review.json --directory .data/quality-stage20-fixtures
pnpm --filter @memory/agent eval:media-review
```

先检查清单和供应商连接再运行；此命令实际调用已配置的视觉模型，默认选择 `gpt-6-luna`，可通过 `MEMORY_EVAL_MODEL` 指定其他已配置模型 ID。新运行目录在 `.data/evaluations/media-review-live-*`，全部报告和原始素材不进入用户资料库。逐项效果和限制见[阶段二十](../../docs/plans/0020-media-review-quality.md)。
