# 人物出现关联测试

清单中的三张公开肖像用于测试“同一人物的两次出现”和“不同人物”，不代表用户的个人资料。姓名仅作为从来源核对的评测标签；本地编码器只接收图片字节和摘要，不接收姓名、网页或标签。

| 文件 | 作者与来源 | 许可 |
| --- | --- | --- |
| subject-a-1.jpg | Pete Souza，[2009 年奥巴马肖像](https://commons.wikimedia.org/wiki/File:Official_portrait_of_Barack_Obama.jpg) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)，须署名；不能将这张图误写为公有领域 |
| subject-a-2.jpg | Pete Souza，[2012 年奥巴马肖像](https://commons.wikimedia.org/wiki/File:President_Barack_Obama.jpg) | 美国联邦政府作品，公有领域 |
| subject-b-1.jpg | David Lienemann，[2013 年拜登肖像](https://commons.wikimedia.org/wiki/File:Joe_Biden_official_portrait_2013.jpg) | 美国联邦政府作品，公有领域 |

下载原件不作改动；推理副本在本地缩放。完整 URL、大小和 SHA-256 在 [manifest.json](manifest.json)。原图保存在被 Git 忽略的 `.data/people-fixtures/`。

```bash
python3 examples/people/download.py
python3 examples/photos/download.py
pnpm --filter @memory/agent eval:memory:hybrid
```

需先安装[本地处理器](../../docs/local-memory-processing.md)。此测试不调用外部视觉模型、不训练。增加 `--reader` 才调用已配置的读取模型；它接收的是虚构文本证据，不接收肖像。三张公开正面肖像只能验证这一组关联和代码路径，不能证明日常照片、侧脸、遮挡、年龄变化或大规模聚类的准确率。真实身份仍需用户核对。
