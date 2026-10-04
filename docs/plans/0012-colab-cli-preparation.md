# 阶段十二：Colab CLI 准备与后续路线

> 历史阶段记录：保留当时的决策、实测和限制。当前产品以 [产品定义](../product.md)、[架构](../architecture.md) 和 [Harness 重构计划](0018-harness-refactor.md) 为准。

## 范围与约定

2026-10-04，用户明确暂不训练，本阶段仅安装官方 Colab CLI 并验证本地可用性。用户已说明拥有 Colab Pro；后续实际需要连接时再提供 Google 官方授权链接，账户权限、剩余算力与可分配 GPU 届时实测。

本阶段不登录 Google、不申请运行时、不上传数据、不执行训练，也不增加应用 API 或将 `training` 能力标为已实现。主机工具安装与 Pi/Harness 的受控调用是独立步骤。

## 安装与验证方式

当前主机为 Linux / WSL，已有 Python 3.12.3 和 uv。官方 `google-colab-cli` 0.7.4 要求 Python >= 3.12，使用用户级独立工具环境安装，固定版本便于复现：

```bash
uv tool install google-colab-cli==0.7.4
colab version
colab --help
```

在项目目录验证主机终端能找到 `colab`，版本为 0.7.4，帮助命令退出码为 0。仅运行本地信息命令不证明 Google 授权、GPU 分配或远程任务已经可用；本阶段不运行需要访问账户的命令。

### 2026-10-04 实测结果

- `uv tool install google-colab-cli==0.7.4` 成功，CLI 与依赖安装到用户级独立环境，不修改项目依赖。
- 项目目录下的主机终端找到 `/home/dev/.local/bin/colab`，实际入口为 `/home/dev/.local/share/uv/tools/google-colab-cli/bin/colab`；`uv tool list` 显示 `google-colab-cli v0.7.4`。
- `colab version` 输出 `Version: 0.7.4`，`colab --help` 正常显示命令及默认 OAuth2 认证方式，两者退出码均为 0。
- 文档本地链接检查及 `git diff --check` 通过。本阶段未修改应用行为，没有重跑应用回归测试；以上为真实主机 CLI 验证，未做账户授权或远程 GPU 验证。

## 后续登录与训练接入

- 首次需要连接时使用 CLI 的 OAuth2 流程，例如 `colab --auth oauth2 sessions`，将当次生成的 Google 官方授权链接交给用户。用户在浏览器完成登录，并在本机授权流程中输入授权码；不把授权码、令牌或带授权参数的链接写入项目文档。
- 当前 Pi 沙箱只挂载项目及允许的系统目录，并使用独立 PATH；主机的用户级 CLI 与 Google 凭据不会自动进入沙箱。后续通过服务端适配层提供显式的远程任务操作，限定上传清单、任务工作目录和可用命令，保存任务状态及可审阅记录。
- 训练流程为核验数据快照 → 远程执行 → 下载权重及日志 → 独立闭卷评测。保存数据版本、基础模型版本、训练配置和模型产物摘要；运行时支持检查点恢复，产物下载核验后释放资源。
- Colab Pro 不保证特定 GPU 或无限运行时间。未来正式接入需验证额度不足、分配失败、中断恢复、下载失败和释放运行时，不能只验证脚本成功启动。

## 项目后续顺序

1. **可靠记忆**：扩大中文、同名人物、复杂时间、混合引文、跨会话、纠正与停止取用的评测；分别记录原文支持、自动确认精确率、召回和最终问答结果。当前固定小样本通过不代替广泛验证。
2. **照片与人物**：保留原图和区域证据，支持跨照片关联、未知身份、一次确认影响范围，以及误合并拆分；视觉观察和身份推断保持可区分。
3. **视频与混合检索**：实现片段、转写和时间定位，再依据实际召回效果选择嵌入及重排模型；关键词和人物、时间条件继续参与检索。
4. **个人模型训练**：待用户恢复训练安排后，再通过 Colab 验证参数记忆。与未训练模型及检索辅助问答对照，检查改写问题、时间变化、旧知识保留、未知拒答和停止使用后的模型版本处理。

## 依据

- [Google 官方 Colab CLI](https://github.com/googlecolab/google-colab-cli)、[0.7.4 安装包](https://pypi.org/project/google-colab-cli/0.7.4/)：安装、执行、文件操作与运行时管理。
- [Google Colab CLI 发布说明](https://developers.googleblog.com/introducing-the-google-colab-cli/)：远程微调、下载适配器与运行日志的官方示例。
- [Colab FAQ](https://research.google.com/colaboratory/faq.html)：动态资源额度和运行时限制。
- [LongMemEval](https://arxiv.org/abs/2410.10813)：信息提取、跨会话、时间推理、知识更新与拒答评测。
- [VisualMem](https://arxiv.org/abs/2605.28806)：保留独立视觉记忆及与对话关联的证据，作为照片阶段的设计参考。
