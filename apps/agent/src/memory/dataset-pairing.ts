import type { SampleTimeQuality, TrainingSample } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import { UserFacingError } from "../errors.js";

type SampleRow = { data: string; version: number; status: TrainingSample["status"]; stale: number };
const sourceKey = (sample: TrainingSample) => JSON.stringify([...sample.memoryRefs].sort((a, b) => a.id.localeCompare(b.id)));

/** Versioned training/evaluation correspondence; semantic equivalence remains an explicit review decision. */
export class DatasetPairings {
  constructor(private readonly store: MemoryData) {}

  get(datasetId: string, id: string) {
    const row = this.store.db.prepare("SELECT data,version,status,stale FROM dataset_samples WHERE datasetId=? AND id=?")
      .get(datasetId, id) as SampleRow | undefined;
    return row && { ...JSON.parse(row.data) as TrainingSample, version: row.version, status: row.status, stale: !!row.stale };
  }

  candidates(sample: TrainingSample) {
    if (sample.intendedUse !== "evaluation") return [];
    const rows = this.store.db.prepare(`SELECT s.data,s.version,s.status,s.stale FROM dataset_samples s
      JOIN dataset_sample_dependencies d ON d.sampleId=s.id WHERE s.datasetId=? AND d.kind='memory' AND d.parentId=?
      AND json_extract(s.data,'$.intendedUse')='training' AND json_array_length(json_extract(s.data,'$.memoryRefs'))=? ORDER BY s.id`)
      .all(sample.datasetId, sample.memoryRefs[0].id, sample.memoryRefs.length) as SampleRow[];
    return rows.map((row) => ({ ...JSON.parse(row.data) as TrainingSample, version: row.version, status: row.status, stale: !!row.stale }))
      .filter((training) => sourceKey(training) === sourceKey(sample));
  }

  trainingSamples(samples: TrainingSample[]) {
    return [...new Map(samples.flatMap((sample) => this.candidates(sample)).map((sample) => [sample.id, sample])).values()];
  }

  quality(sample: TrainingSample, resolve = (id: string) => this.get(sample.datasetId, id)): SampleTimeQuality["issues"] {
    if (sample.intendedUse !== "evaluation" || sample.status === "excluded") return [];
    const issue = (code: string, message: string, severity: "blocking" | "review" = "blocking") => [{ code, message, severity }];
    if (!sample.evaluationOf) return issue("evaluation-unpaired", "评测题尚未关联训练题，请选择并核对所考事实");
    const training = resolve(sample.evaluationOf.id);
    if (!training || training.datasetId !== sample.datasetId || training.intendedUse !== "training" || training.stale || sourceKey(training) !== sourceKey(sample))
      return issue("evaluation-training-unavailable", "关联训练题或来源不可用，请重新选择或排除评测题");
    if (training.version !== sample.evaluationOf.version)
      return issue("evaluation-training-changed", "关联训练题已修订，请重新核对当前版本");
    if (training.status === "excluded") return issue("evaluation-training-excluded", "关联训练题已排除，请重新选择或排除评测题");
    if (training.answer !== sample.answer) return issue("evaluation-answer-mismatch", "评测答案与关联训练题不一致，请核对所考事实后修订");
    if (training.status !== "ready") return issue("evaluation-training-unreviewed", "关联训练题尚未核对", sample.status === "ready" ? "blocking" : "review");
    if (sample.checks.includes("evaluation-pair-require-review")) return issue("evaluation-pair-require-review", "关联训练题已更改，需重新核对所考事实", "review");
    return [];
  }

  assertReviewed(sample: TrainingSample, resolve: (id: string) => TrainingSample | undefined) {
    const problem = this.quality(sample, resolve).find((issue) => issue.severity === "blocking");
    if (problem) throw new UserFacingError(422, "EVALUATION_MISMATCH", problem.message);
  }
}
