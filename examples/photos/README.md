# 公开照片测试

三张真实照片由 Exa 搜索发现，使用 Wikimedia Commons 的原件和许可说明：咖啡杯（Jon Sullivan 释放至公有领域）、雾中桥梁（MallardTV，CC0）以及 NASA 宇航员/旗帜照片（美国公有领域，NARA 16685052）。准确来源、下载地址和 SHA-256 见 [manifest.json](manifest.json)。这些照片不代表用户经历。

```bash
python3 examples/photos/download.py
pnpm --filter @memory/agent eval:photos:live
```

下载脚本只读取清单中的三个公开地址，校验摘要后保存到被 Git 忽略的 `.data/photo-fixtures/`。评测另外生成一张白底英文诱导指令图，检查图内指令仅作为不可信材料处理；它是程序生成的补充用例，不冒充公开摄影素材。

真实模型评测使用已配置的 `gpt-6-luna`，不存在该连接时使用第一个已配置模型。在新建的 `.data/evaluations/photos-live-*` 目录中运行实际 Pi、导入队列和数据库，临时启用该进程的图片输入标记，不修改主工作台模型配置。请求只包含选中的缩放图片，不发送文件名、来源网页、许可文字或期待答案。每张处理完成后保存报告，所有候选仍为草稿；重复导入检查是否复用回执。

打开报告及原图逐条核对。在该评测目录写 `reviewed.json`，明确核对者、接受的候选 ID/版本、必要修订和核对说明，例如：

```json
{
  "reviewer": "核对者姓名或工具，并说明核对方式",
  "entries": [
    {
      "id": "报告中的候选 UUID",
      "version": 1,
      "content": "对照原图修订的观察内容",
      "reason": "修订依据"
    }
  ],
  "notes": ["哪些观察有依据，哪些候选被排除或修订"]
}
```

`title`、`content`、`uncertainty` 和 `reason` 均可省略，省略表示保留原值。诱导指令图不能通过该脚本进入已确认记忆。每个公开场景均应有核对通过的记录，咖啡场景至少一条用于停止取用检查。执行：

```bash
pnpm --filter @memory/agent eval:photos:review /绝对路径/.data/evaluations/photos-live-目录
```

第二步在独立新会话中检查三个场景的检索与回答，并问到访经历、姓名/日期和咖啡偏好等不可由照片证明的问题；随后停用咖啡来源，检查检索排除及不再发送提取请求。报告保存原始候选、核对修订、实际回答、引用轨迹和停用结果，不把答案关键词命中当作视觉准确率。

这个固定小样本用于发现集成问题、观察误识别并验证核对流程，不能作为自动识别准确率、完整 OCR/提示注入防护或个人模型训练效果的证明。真实结果和剩余工作见 [阶段十三](../../docs/plans/0013-photo-memory.md)。
