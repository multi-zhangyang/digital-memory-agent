# 独立工具质量评测

这组固定材料用于检查精确编号、相近事件、纠正、日期、人物歧义、图像检索和视觉描述，不代表用户经历或个人参数记忆。开发题与保留题分别报告，修正固定后才运行保留题，不再依据这组保留结果调参。

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

`media-review.json` 与 `archive-label.svg` 用于主 Agent 的原件局部复核、日期修复和连续任务验证。公开室内照片保留 CC0 来源和摘要，标签是程序绘制的确定性材料。评估器显式预置错误草稿，并在真实生成问题后删除一处日期，检验恢复过程；这些注入不冒充模型自然错误。三批新文字检验偏好采用、纠正及重启后持续使用。读取、修订和交付由真实 Pi/模型完成，评估器不代为审核，原始失败与独立像素核对均保留。

```bash
python3 examples/quality/download.py --manifest examples/quality/media-review.json --directory .data/quality-stage20-fixtures
pnpm --filter @memory/agent eval:media-review
```

先检查清单和供应商连接再运行；此命令实际调用已配置的视觉模型，默认选择 `gpt-6-luna`，可通过 `MEMORY_EVAL_MODEL` 指定其他已配置模型 ID。新运行目录在 `.data/evaluations/media-review-live-*`，全部报告和原始素材不进入用户资料库。逐项效果和限制见[阶段二十](../../docs/plans/0020-media-review-quality.md)。
