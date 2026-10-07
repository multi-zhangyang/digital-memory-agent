# Third-party component notices

Third-party components and local processing models use the following licenses. Imports are adapted to this workspace; interface labels may be localized.

## shadcn/ui

Source: https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md

The workbench navigation composes the official Sidebar primitives and blocks:
https://ui.shadcn.com/blocks/sidebar

The photo import flow composes the official Dialog, Field, Select, Checkbox,
Switch and Spinner components. Spinner was installed from the official registry:
https://ui.shadcn.com/docs/components/radix/spinner
Its `cn` import is adapted to the existing workspace utility (`@/lib/utils`),
and its accessible loading label is localized; no separate `cn` package is used.

The memory entity, event and dataset review dialogs compose the existing official
Dialog, Table, Accordion, Checkbox, Field, Input, Select and Button primitives.
They use the workspace's neutral theme tokens and dynamically load with the memory
library. Private photo previews use unoptimized Next Image through the source
verification API. Job traces continue to use AI Elements Task and Tool components.
Dataset rebuilding uses the same Dialog, Table, Badge, Empty and Alert components.
The sample question and badges wrap through component composition on narrow screens;
no separate visual controls or theme are introduced. Rebuild tools continue to show
their real Pi inputs, outputs and failures in the existing AI Elements Tool display.
Training/evaluation pairing review composes the same Accordion, Field, Select,
Input, Textarea and Alert primitives. It displays actual paired sample versions
and keeps editing and failure state; the Agent uses the existing AI Elements Tool
input/output components with real Harness events.
Batch dataset audits compose official ToggleGroup, Progress, Field, Select,
Table and Badge components. Toggle and ToggleGroup were installed through the
official shadcn CLI registry; their `cn` import uses the existing workspace utility.
Progress forwards its real value to the Radix root so assistive technology receives
the actual job progress. Processor decisions and errors use persisted business data;
chat continues to use AI Elements Tool and Task without separate chat controls.
Sample status filters reuse ToggleGroup; audit question links use the official Button
link variant to select the actual sample. Follow-up review badges retain the original
decision and display current persisted sample versions and actors.
Audit Table rows stack vertically below the small breakpoint so original and
follow-up reasons remain readable on phones. This adapts official component
composition and responsive layout without changing the table primitive or theme.
来源作答证据继续组合现有 Accordion、FieldGroup、FieldTitle 和 FieldDescription，
按实际核验记录展示并换行；没有修改上游组件、主题或 AI Elements 工具事件协议。

生活活动视图组合官方 Card、FieldGroup、Input、Textarea、Checkbox、Accordion、
Tabs、Empty、Skeleton 和 Alert。导航调整 Sidebar 的组合和宽度，详情在窄屏使用
现有官方 Sheet；活动命令仍由服务端实施。`useIsMobile` 接受可选断点，使详情在
1100px 以下切换而 Sidebar 保留原默认断点。沿用 neutral 主题与 Geist，没有独立控件或主题。

工作台交互重构继续组合官方 Sidebar、Tabs、Card、FieldGroup 和 Skeleton。首页建议与
输入复用 AI Elements Suggestion / PromptInput，未替换官方滚动实现。应用层通过 React
Activity 保留页面状态并暂停隐藏页 effects，通过 memo 复用不变的 Markdown 与工具结果。
过渡使用现有 tw-animate-css，尊重 prefers-reduced-motion；没有新增动画或基础控件依赖。

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## AI Elements

Source: https://raw.githubusercontent.com/vercel/ai-elements/main/LICENSE

The full Apache License 2.0 is included in `LICENSES/Apache-2.0.txt`.

Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

### Local component adaptations

AI Elements remain based on the official components. `PromptInput` accepts
`resetOnSubmit=false` for controlled drafts so native form reset cannot silently
reset model or permission selectors. Tool code previews load on demand; reasoning
uses Streamdown without eagerly importing optional diagram/math/highlighting
plugins. Code block tokens use exact content keys, a bounded cache, a plain-text
path and cache-hit callbacks to keep edited previews current. Tool headers allow
long titles to truncate within narrow panes. The model selector, chain of thought
and confirmation components come from the official AI Elements registry, with
workspace import paths adapted. These adaptations are in
`apps/web/src/components/ai-elements/`.

Runtime views compose the official ToolInput/ToolOutput, Confirmation request and
outcome states, PromptInput, Queue, Task, Terminal and Context components. Tool
labels are localized, primitive JSON results (including false, zero and null)
remain visible, and text output uses the CodeBlock plain-text path without
tokenizing each line. ToolHeader also accepts native trigger attributes. These
changes keep the Pi transport and persisted execution state in the application
adapter; they do not replace Pi with a second model loop.

Video frame memory drafts compose the existing AI Elements Attachment and
shadcn Dialog, Field and Textarea without changing upstream primitives. Source
read references and durable draft state belong to the application services.

`RunJobs` composes the existing official Task, ToolInput, Button and Badge
components. Job progress is driven by persisted backend events, separately from
tool submission receipts, and is restored with the conversation after a reload.

生活活动详情组合官方 AI Elements Artifact，恢复操作组合 Confirmation 和 ToolInput；
问题、决定、工具结果和作业状态均来自持久化 Run。MessageContent 的默认正文调整为
`text-base leading-7`，恢复清晰可读的对话字号，详情和代码继续按需加载。步骤关联使用
服务端保存的 stepId，不从界面中的当前计划猜测历史工具所属步骤。

Pi 恢复适配新增显式依赖 `@earendil-works/pi-agent-core` 1.0.0（与已安装 Pi SDK
同版本），使用公开 `runToolCall` 执行已审批但未消费的原始调用。许可与上游项目同为
MIT：https://github.com/earendil-works/pi/blob/main/LICENSE。
检查点、回执和上下文投影在项目适配层实现，没有修改上游包或另建模型循环。

digital memory Harness 重构继续复用这些组件。任务输入保留 PromptInput，
消息与恢复历史共用 Message / Reasoning，库作业与任务作业在 Task 中明确归属；
素材证据、处理中心、数据集和设置由现有 shadcn Dialog、Tabs、Table、Field、
Select、Switch、Badge 与 Alert 组合。新增命令菜单模块复用现有 Command。
业务状态来自服务端作业与 Pi 事件，组件不另建 Agent 循环；本次未修改上游组件源码。

Pi 1.0.0 使用当前安装包公开的 SDK、SessionManager、ResourceLoader、扩展 hooks、
operations 和 ModelRuntime；项目适配位于 `apps/agent/src/integrations/pi/`，
应用装配位于 `apps/agent/src/application/`。产品 Skills 与模板通过上游资源加载器
提供。没有复制 CLI 全部交互，也没有依赖上游尚未导出的 Harness 接口。

Pi 工作台消息投影继续组合官方 Message、Reasoning、Tool、Checkpoint、Queue、
Context、Artifact 和 Attachments。工具参数流、最终消息校正、父子调用和作业关联
位于应用适配层；共享归约器通过 `@memory/contracts/execution` 提供，不改写 Pi
执行循环。历史分页滚动定位复用 Conversation 的 `use-stick-to-bottom` 上下文。
持久工作区和会话树使用 shadcn Tabs、Dialog、ScrollArea、Button 与 Badge，
只挂载已访问标签以控制代码高亮等组件的成本。原有 Markdown 安全链接适配抽为
共享模块，没有新增样式系统。Web 扩展 UI 使用公开 Theme 作为文字格式兼容器，
剥离终端 ANSI 格式；任意 TUI 组件仍明确不支持。

会话居中布局组合 shadcn Sidebar 的 inset 变体、DropdownMenu、Resizable 和 Sheet；
项目选择使用官方子菜单，窄屏工作区使用全宽 Sheet。输入、消息及交付文件继续组合
AI Elements PromptInput、Message、Artifact 和 Attachments，仅调整应用层的布局和阅读尺寸。
工作区明确打开与恢复标签的状态由应用层管理；菜单关闭时保留已进入文本框的输入焦点。
这次布局重设计没有替换上游基础控件或新增视觉样式系统。

Agent first 适配继续组合官方 PromptInput、Attachments、Task 和 Tool 组件。
单文件上传重试使用 shadcn Alert / Button；仅附件任务保留真实附件与空用户正文，
逐素材覆盖和训练文件下载来自实际后台结果。应用层 Markdown 链接适配允许
受限的同源数据集下载路由；其他本地路径不作为可执行链接。下载失败使用
shadcn Alert 留在当前会话，交付回执的版本与摘要检查位于应用层。
Pi 的异步 context hook 在本轮记忆命令提交后重建当前上下文，处理同轮多工具结果的
调用配对；原生 JSONL 历史保持留存。没有修改 Pi 包或另写模型循环。

媒体复核在应用层继续组合官方 Attachments / AttachmentPreview / AttachmentInfo、
ToolInput / ToolOutput 与 CodeBlock；局部预览使用包含原件和图像摘要的同源地址，
图片加载失败由 shadcn Alert 显示。样本修订使用既有 FieldGroup / Field / Input /
Textarea / Button。未复制另一套基础控件，也未修改这些上游组件实现。

### 会话与响应适配（2026-10-07）

会话控制沿用 AI Elements Context 和 shadcn Dialog、Tabs、Field、Button：读取 Pi session 的上下文用量，保留原生压缩摘要；压缩保留重点和资源使用入口是业务组合，未修改上游基础组件。

AI Elements `MessageResponse` 使用 React 默认浅比较，避免仅比较正文时吞掉
`isAnimating` 完成事件；业务 Markdown 接入 Streamdown 自带 `animated`、
`isAnimating` 与 `styles.css`，150ms 淡入、不增加 stagger，历史内容不运行
流式动画。减少动画偏好同时用于 Streamdown 样式和官方 Shimmer。
ToolContent 使用 tw-animate-css 已有的 Radix collapsible 高度动画；业务层
控制工具摘要、展开选择及结果页签，不随执行完成自动折叠。Reasoning 在显式
`defaultOpen=false` 时同时禁用自动开合，保留用户手动展开的思考内容。没有复制参考项目
的前端实现；调研来源及采用边界见[阶段 0039](docs/plans/0039-agent-interaction-and-tool-loading.md)。

ConversationContent 在 Collapsible 触发器及工具页签的指针、键盘操作之前调用
`use-stick-to-bottom` 的 `stopScroll`，避免手动展开被当成流式增量自动贴底。
继续使用官方滚动实现和回到底部按钮。工具参数与结果的动态 CodeBlock 使用
shadcn Skeleton 作为局部 loading 边界，避免首次加载挂起上层消息、缩短会话高度。
原有 Collapsible 高度动画保留。

业务导航使用 React transition、Suspense 与 Activity 保留页面状态；空闲时分次加载
常用页面代码，移除整页重复淡入。命令面板仍由 shadcn Command 组成；审批代码详情
复用官方 CodeBlock 与 Skeleton 的局部加载边界。会话控制及终态任务状态复用已有
组件内状态，运行中的状态与主动操作照常刷新。未替换 AI Elements 滚动或流式组件。

### 视频证据组合

视频工具结果、处理来源与记忆证据使用现有 AI Elements `Attachment`、
`Sources`、`Tool`，配置及时间输入使用 shadcn `Field`、`Input`、`Select`、
`Switch`，结果和播放窗口使用 `Tabs`、`Dialog`。本轮未覆盖官方基础组件；
`ProcessingAssets`、`VideoEvidence`、`VideoSourceViewer` 仅组合这些组件和
原生 video 播放控件。来源时间、预览及错误来自真实同源 API，官方组件源码
及已有性能适配继续保留。

`VideoIndexFrames` 将现有官方 `Attachments` / `AttachmentPreview` /
`AttachmentInfo` 与 shadcn `Badge`、`Dialog` 组合为索引画面结果；
素材检索与人物查找使用既有 `FieldGroup`、`Empty`、`Table` 和视频证据窗口。
进度、失败和时间均来自业务回执。没有另写基础控件；工作台在移动断点保留
同一个 Resizable 主面板，避免重新挂载丢失业务窗口状态。

## FFmpeg / FFprobe

项目通过子进程使用主机安装的 FFmpeg 与 FFprobe，不在仓库分发二进制。
上游项目和使用文档：https://ffmpeg.org/documentation.html；许可说明：
https://ffmpeg.org/legal.html。实际许可证依所安装构建及其启用的库而定。
视频读取使用固定容器解析器与文件描述符，只启用 `fd,pipe` 协议；
返回画面经 sharp 裁剪、缩放并清除元数据。评测的程序生成视频仅存隔离数据目录。
自然视频独立下载，其作者、公有领域依据和原件摘要见
`examples/videos/manifest.json`；原件不随仓库分发。公开图片拼接对照视频的
素材作者和许可继承 `examples/photos/manifest.json` 与
`examples/people/manifest.json`，包括 Pete Souza 的 CC BY 3.0 肖像署名。

## Sharp

Package: `sharp` 0.35.5, https://sharp.pixelplumbing.com

Licensed under Apache License 2.0. The package includes its license and notices.
It locally decodes and normalizes selected photos before model requests.
Public evaluation images are downloaded separately; their sources and licenses
are recorded in `examples/photos/manifest.json`, and image files are not included
in this repository.

## Pierre Diffs

Package: `@pierre/diffs`, https://diffs.com/docs

Copyright 2025 Pierre Computer Company

Licensed under the Apache License, Version 2.0. The dependency includes the full
license in `@pierre/diffs/LICENSE.md`. The application uses its React `FileDiff`
component and built-in styles without modifying the library source.

应用层在首次打开差异查看器时，通过公开的 `preloadHighlighter` 接口加载内置主题。
这避免了 1.3.6 在开发模式 StrictMode 重新挂载时，将尚未填入内容的 `<pre>`
误当成已完成渲染而显示空白；仍然按需加载，未修改上游组件或关闭 StrictMode。

https://www.apache.org/licenses/LICENSE-2.0

## jsdiff

Package: `diff`, https://github.com/kpdecker/jsdiff

BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


## 特征服务与可选旧版本地适配

具体编码器仅作为显式启用的兼容适配和隔离评测依赖，不是默认部署。

- exifr 7.1.3: https://github.com/MikeKovarik/exifr — MIT；在服务端读取 EXIF 元信息，发送的图片由 sharp 去除附加信息。

- sqlite-vec 0.1.9: https://github.com/asg017/sqlite-vec — MIT OR Apache-2.0, Alex Garcia. The trusted installed extension is loaded by the server; arbitrary extension loading is then disabled.
- multilingual-e5-small: https://huggingface.co/intfloat/multilingual-e5-small — MIT.
- SigLIP2 base: https://huggingface.co/google/siglip2-base-patch16-224 — Apache-2.0; ONNX conversion: https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX.
- YuNet face detection: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet — MIT.
- SFace face recognition features: https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface — Apache-2.0.

Pinned upstream revisions, file hashes and license downloads are recorded in
`services/memory-worker/models.json`. Model files and their license copies are
installed in the private model cache and are not committed to this repository.
Python dependency versions are locked in `services/memory-worker/uv.lock`.

Public evaluation portraits retain author, license and source attribution in
`examples/people/manifest.json` and its README. In particular, the 2009 Obama
portrait by Pete Souza uses CC BY 3.0; it is not labeled public domain.
Other public photo attributions are in `examples/photos/manifest.json`.

### 统一嵌入隔离评估

实验使用 [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
固定版本 `914f7f89142e33e77833254d9c9b90c3cef7303b`，许可 Apache-2.0。
通过 [Sentence Transformers](https://github.com/huggingface/sentence-transformers)
与 [Transformers](https://github.com/huggingface/transformers)（均 Apache-2.0）
加载官方模型，关闭音频，仅测文字与视觉。PyTorch 与 torchvision 使用上游
BSD 风格许可。实验环境单独锁定；权重及其上游模型说明保存在忽略的模型缓存。
没有复制或修改这些库的实现，也没有替换正式 worker。公开图像和视频的署名、
来源与许可分别保留在 `examples/quality/images.json`、`examples/videos/manifest.json`。

### 人脸 GPU 隔离评估

使用 [InsightFace](https://github.com/deepinsight/insightface) 的 SCRFD 检测、
ArcFace R50 识别和五点对齐代码，固定提交
`3e6486942a1be2da0e5b475fac375ea73264bd21`（v0.7），代码许可 MIT。
三个上游 Python 文件原样下载到忽略目录，使用空包入口绕过整包自动下载和
无关功能；未修改检测解码、对齐或识别预处理。代码许可原文随缓存保留。

`buffalo_m` / `buffalo_l` 官方发布包中的预训练权重限非商业研究用途，
不继承代码的 MIT 商业授权。实验只加载两个检测器与共享的
`ResNet50@WebFace600K`，不加载年龄、性别或密集关键点模型。
固定来源、发布包及提取文件摘要见 `examples/quality/face-models.json`。
ONNX Runtime 使用 MIT 许可；CUDA/cuDNN 库遵循 NVIDIA 对应许可。
公开照片的来源和署名仍保留在 `examples/quality/images.json`，压力测试仅在
本地生成派生像素。正式 worker 尚未切换。
