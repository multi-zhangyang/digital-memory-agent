# 视频原件索引对照

两段自然视频保留[清单](manifest.json)中的原始字节、摘要、作者和来源许可。原件存放在 `.data/video-fixtures/`，不进入 Git。第一段来自美国国会议员公务发布，第二段来自白宫；来源页均标记公有领域。来源网页上的姓名、日期和说明仅用于人工对照，不送入编码器或 Agent。

运行 `python3 examples/videos/download.py` 获取并校验原件；运行 `pnpm --filter @memory/agent eval:video-index` 使用已安装的本地编码器处理隔离资料库。验证同时把已有公开图片按两秒一段组成对照视频，便于核对内容变化和重复人物；拼接片段不是自然动作样本。公开肖像的 CC BY 3.0 署名与其他素材许可见 [people](../people/manifest.json) 和 [photos](../photos/manifest.json)。

输出记录实际画面时间、检索排名、未知人物候选、重启与非空恢复结果。检测完成和候选相似度不证明身份，抽样画面不代表完整视频覆盖；不调用外部模型，不训练个人模型。

需要验证真实 Agent 查找、读取和交付时，使用 `pnpm --filter @memory/agent eval:video-index --agent`。该选项只把所选的公开图片拼接片段画面发送给已配置的 `gpt-6-luna`；自然视频不发送，姓名与来源标签仍不作为模型输入。
