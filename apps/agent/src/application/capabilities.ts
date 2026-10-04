import type { CapabilityStatus } from "@memory/contracts";
import type { AppConfig } from "../config.js";
import type { Store } from "../store.js";
import type { MemoryFeatureService } from "../memory/feature-service.js";
import { processingModel } from "../memory/processing-policy.js";
import { videoAvailable } from "../memory/video-source.js";

export function capabilityStatuses(config: AppConfig, store: Store, features: MemoryFeatureService): CapabilityStatus[] {
  const model = (purpose: "text" | "photo" | "video" | "dataset" | "dataset-review") => { try { return processingModel(config, store.memories.ledger.settings(), purpose).model.id; } catch { return undefined; } };
  const text = model("text"), photo = model("photo"), video = model("video"), dataset = model("dataset"), review = model("dataset-review");
  const featureStatus = features.status();
  const status = (id: string, label: string, tasks: string[], tools: string[], configured = true, detail?: string): CapabilityStatus => ({ id, label, tasks, tools, kind: "service", implemented: true, configured, available: configured, verification: "protocol-tested", detail });
  return [
    { ...status("harness.execution", "任务执行与会话", ["H1"], ["read", "write", "edit", "bash", "update_plan", "write_artifact", "ask_user"], config.providers.length > 0), kind: "harness" },
    { ...status("harness.web", "联网检索", ["H1"], ["web_search", "web_read"], store.harness.settings.searchEnabled && !!store.harness.settings.searchKey), kind: "harness" },
    { ...status("harness.extensions", "Skills、提示模板与 MCP", ["H1"], ["tool_search"], true, "产品资源和已启用扩展通过 Pi SDK 加载"), kind: "harness" },
    status("memory.text", "文字处理", ["M1", "M2"], ["process_assets"], !!text, text || "未配置文字处理模型"),
    { ...status("memory.photo", "照片观察", ["M1", "M2"], ["process_assets", "read_evidence"], !!photo, photo || "未配置支持图片输入的模型"), verification: "not-verified" },
    status("memory.evidence", "原件与观察检索", ["M3"], ["search_evidence", "read_evidence"]),
    status("memory.facts", "确认记忆与事件", ["M2", "M3", "M4"], ["search_memories", "query_events", "propose_memory", "inspect_memories", "change_memories", "manage_memory_links"]),
    { ...status("memory.embeddings", "本地语义、图像与人物特征", ["M1", "M2", "M3"], [], !!config.localProcessor, "检索编码器可替换；人物聚类仅提供候选关联"), available: featureStatus.state === "ready", verification: "not-verified" },
    status("memory.jobs", "独立后台作业与恢复", ["M1", "M2", "M4", "M5"], ["process_assets", "read_job_result", "manage_job"]),
    status("memory.dataset", "训练与评测数据准备", ["M4", "M5"], ["build_dataset", "rebuild_dataset", "inspect_dataset", "review_dataset", "deliver_dataset"], true, dataset ? `问题生成模型：${dataset}；Agent 可重建、修订样本并核验交付` : "来源核验和模板导出可用；模型问题生成未配置"),
    status("memory.dataset-review", "后台问答核验", ["M5"], ["audit_dataset", "read_job_result", "manage_job"], !!review,
      review ? `核验模型：${review}；逐来源保存模型审阅与待核对决定` : "未配置问答核验模型"),
    { ...status("memory.video", "视频画面与时间定位", ["M1", "M2", "M3"], ["process_assets", "search_evidence", "read_evidence"], !!video && videoAvailable(),
      !videoAvailable() ? "未安装 FFmpeg / FFprobe" : video ? `画面处理模型：${video}；按配置抽样，不含声音转写` : "未配置视频画面处理模型"), verification: "not-verified" },
    { ...status("memory.training", "个人模型训练", ["M6"], []), implemented: false, configured: false, available: false, verification: "not-verified", detail: "本阶段暂停；数据集导出不代表训练" },
  ];
}
