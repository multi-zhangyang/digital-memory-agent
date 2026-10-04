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

digital memory Harness 重构继续复用这些组件。任务输入保留 PromptInput，
消息与恢复历史共用 Message / Reasoning，库作业与任务作业在 Task 中明确归属；
素材证据、处理中心、数据集和设置由现有 shadcn Dialog、Tabs、Table、Field、
Select、Switch、Badge 与 Alert 组合。新增命令菜单模块复用现有 Command。
业务状态来自服务端作业与 Pi 事件，组件不另建 Agent 循环；本次未修改上游组件源码。

Pi 1.0.0 使用当前安装包公开的 SDK、SessionManager、ResourceLoader、扩展 hooks、
operations 和 ModelRuntime；项目适配位于 `apps/agent/src/integrations/pi/`，
应用装配位于 `apps/agent/src/application/`。产品 Skills 与模板通过上游资源加载器
提供。没有复制 CLI 全部交互，也没有依赖上游尚未导出的 Harness 接口。

Agent first 适配继续组合官方 PromptInput、Attachments、Task 和 Tool 组件。
单文件上传重试使用 shadcn Alert / Button；仅附件任务保留真实附件与空用户正文，
逐素材覆盖和训练文件下载来自实际后台结果。应用层 Markdown 链接适配允许
受限的同源数据集下载路由；其他本地路径不作为可执行链接。
Pi 的异步 context hook 在本轮记忆命令提交后重建当前上下文，处理同轮多工具结果的
调用配对；原生 JSONL 历史保持留存。没有修改 Pi 包或另写模型循环。

媒体复核在应用层继续组合官方 Attachments / AttachmentPreview / AttachmentInfo、
ToolInput / ToolOutput 与 CodeBlock；局部预览使用包含原件和图像摘要的同源地址，
图片加载失败由 shadcn Alert 显示。样本修订使用既有 FieldGroup / Field / Input /
Textarea / Button。未复制另一套基础控件，也未修改这些上游组件实现。

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


## Local memory processing

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
