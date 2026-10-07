# 特征服务接入协议

项目调用模型服务，不安装或指定用户的模型。设置入口为「模型连接 → 检索与人物服务」。服务可运行于本机 CPU/GPU、局域网或远端；设备选择由服务端部署控制。文字、图像和人脸分别配置，可以指向同一地址和模型。

## OpenAI 兼容文字嵌入

基础地址后追加 `/embeddings`，使用 POST 和可选 `Authorization: Bearer <密钥>`：

```json
{"model":"用户填写的模型名","input":["待编码文字"],"encoding_format":"float"}
```

响应需包含 `data: [{index: 0, embedding: [...]}]`，索引不得缺失或重复，结果会按 index 排序并归一化。连接探测使用固定文字获取维度。仅适用于文字嵌入，不把 OpenAI 兼容聊天接口当作嵌入接口。查询和文档的任务前缀由所接服务负责。

该标准不报告逐条 token 数或截断情况，内部记录为 `null`（未知）。服务必须拒绝超长输入或完整编码，不能静默丢弃尾部。更换同名模型权重、维度或前处理时，用户须更新配置中的版本标记。

## Memory Features v1

配置地址是完整的 POST 端点，JSON 请求，可选 Bearer 认证。以下 `model` 均由用户配置，`capability` 为 `text`、`image` 或 `face`。服务不应根据调用隐式下载其他模型。

### 能力探测

请求：

```json
{"protocol":1,"action":"info","capability":"image","model":"用户填写的模型名"}
```

响应示例：

```json
{"protocol":1,"capabilities":["text","image"],"revision":"weights-and-preprocessing-v3","dimensions":768,"spaceId":"shared-retrieval-space-v3"}
```

`dimensions` 是当前请求能力的实际输出维度，范围 1–8192，不必是示例中的 768。`revision` 必须随权重、池化、提示前缀、归一化、检测或对齐流程改变，并在后续每次成功响应中返回相同值。运行中版本不一致会拒收结果；保存配置或重试可重新探测并建立对应索引。

`spaceId` 可省略。只有同一服务地址、协议、模型、用户版本标记、服务 revision、维度及明确相同的 spaceId，才能复用文字与找图的查询向量。维度相同本身不代表空间相同。人脸向量始终独立检索。

### 文字编码与找图查询

```json
{"protocol":1,"action":"embed","capability":"text","model":"用户填写的模型名","texts":["待编码文字"],"role":"passage"}
```

响应结构（向量仅作结构示例，实际长度须等于探测维度）：

```json
{"revision":"weights-and-preprocessing-v3","vectors":[[0.6,0.8]],"truncated":[false],"tokens":[12]}
```

`role` 为 `query` 或 `passage`，服务负责模型特有的任务前缀和池化。`image` 能力也必须支持 `embed`，用于将找图文字编码到图片的向量空间。各数组须与 texts 一一对应，truncated 为布尔值，tokens 为非负整数；真实截断必须报告 true。单批最多 16 条、每条最多 8192 个 JavaScript 字符；业务索引实际使用更短的重叠片段。

### 图片或人脸处理

```json
{
  "protocol":1,"action":"image","capability":"face","model":"用户填写的模型名",
  "image":{
    "data":"JPEG 的 base64 内容","mimeType":"image/jpeg","sha256":"发送像素文件的 SHA-256",
    "width":1280,"height":960,"coordinateSpace":"exif-oriented"
  }
}
```

图片已在本机按 EXIF 定向、转为 JPEG、去除 EXIF/GPS，最长边不超过 1600 像素。服务只能返回该定向坐标系中的区域，不应再次按原始 EXIF 旋转。原始素材路径、文件名、人物姓名和身份确认记录不会随请求发送。

图像能力响应：

```json
{"revision":"weights-and-preprocessing-v3","vector":[0.6,0.8]}
```

人脸能力响应：

```json
{
  "revision":"face-weights-and-alignment-v2","coordinateSpace":"exif-oriented",
  "faces":[{
    "region":{"x":0.1,"y":0.2,"width":0.2,"height":0.3},
    "detectionScore":0.95,"quality":"usable","vector":[0.6,0.8]
  }]
}
```

region 为相对于发送图片宽高归一化的矩形，必须落在 [0,1] 内且面积为正。最多 256 张脸，detectionScore 在 [0,1] 内。`quality: "usable"` 必须返回有效向量；`quality: "small"` 表示该适配判为不可用于身份匹配，vector 必须为 null。是否太小及检测门槛由服务按实际模型定义。未检测到脸返回 `faces: []`，不得用占位向量伪造。

所有向量必须为非零、有限数值数组，长度与能力探测一致；应用再做 L2 归一化。服务不返回人物姓名，身份关联由本项目保留原件依据和用户确认记录。

## 失败、配置与验证

失败使用非 2xx 状态。应用不回传服务原始错误正文，每请求最长 60 秒、响应上限 8 MiB，拒绝重定向。取消或配置切换会中止旧请求，旧结果不得写入新索引。当前启用通道的探测采取整体可用判定：任一通道失败时显示不可用，保留关键词检索；独立停用故障通道后可继续使用其余通道。

设置 API：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/settings/features` | 脱敏配置与运行状态 |
| `POST /api/settings/features/:channel` | 保存并立即应用单项配置 |
| `POST /api/settings/features/:channel/test` | 测试请求中的配置，不保存，不取私人资料 |
| `POST /api/settings/features/policy` | 保存人物候选阈值与次优差值 |

连接请求包含 `enabled`、`protocol`、`baseUrl`、`modelName`、`revision`，可选 `apiKey`、`clearApiKey`。policy 请求包含 `faceMatchThreshold` 和 `faceMatchMargin`，范围均为 [0,1]。关闭能力后对应服务不会再收到新资料。密钥不进入公开状态、向量指纹或浏览器持久存储。

`apps/agent/test/feature-providers.test.ts` 使用本地 HTTP 协议替身验证接入、密钥、版本及索引迁移；`memory-graph.test.ts` 验证单独切换语义模型时人物关联仍保留。它们验证项目接口与业务边界，不代表任何实际模型的效果。真实模型评测另见 [quality README](../examples/quality/README.md)。
