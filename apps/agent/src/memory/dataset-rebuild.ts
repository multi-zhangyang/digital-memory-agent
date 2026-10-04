import { createHash } from "node:crypto";
import type { DatasetRebuildInput, DatasetScope, MemoryDataset, MemoryEntry, TrainingSample } from "@memory/contracts";
import type { MemoryData } from "./data.js";
import { DatasetLedger, type DatasetInput } from "./dataset-ledger.js";
import { DATASET_GENERATOR_VERSION } from "../dataset-question-generation.js";
import { UserFacingError } from "../errors.js";

export function datasetSampleId(datasetId: string, kind: string, ids: string[]) {
  const hex = createHash("sha256").update(JSON.stringify([datasetId, kind, ids])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
type SampleRow = { data: string; version: number; status: TrainingSample["status"] };

/** New frozen inputs retain the original selection and reuse only unchanged, supported sample versions. */
export class DatasetRebuilds {
  constructor(private readonly data: MemoryData, private readonly ledger: DatasetLedger) {}

  private currentScope(scope: DatasetScope): DatasetScope {
    if (!scope.memoryIds) return { ...scope };
    const pending = [...scope.memoryIds], seen = new Set<string>(), current = new Set<string>();
    while (pending.length) {
      const id = pending.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const memory = this.data.memories.get<MemoryEntry>("memory", id);
      if (memory?.supersededBy) pending.push(memory.supersededBy);
      else current.add(id);
    }
    return { ...scope, memoryIds: [...current] };
  }

  submit(input: DatasetRebuildInput, allowedAssetIds?: readonly string[]) {
    return this.data.memories.transaction(() => {
      const existing = this.ledger.find(input.requestKey);
      if (existing) {
        if (existing.rebuild?.datasetId !== input.datasetId || existing.rebuild.revision !== input.revision)
          throw new UserFacingError(409, "COMMAND_CONFLICT", "此请求已用于其他数据集重建");
        return existing;
      }
      const previous = this.ledger.get(input.datasetId);
      if (previous.revision !== input.revision) throw new UserFacingError(409, "VERSION_CONFLICT", "数据集已更新，请重新检查后重建");
      if (["queued", "running"].includes(previous.status)) throw new UserFacingError(409, "DATASET_BUSY", "请等待当前构建结束后重建");
      const next = this.ledger.freeze({ requestKey: input.requestKey, title: previous.title, space: previous.space,
        scope: this.currentScope(previous.scope), format: previous.format, allowedAssetIds,
        ...(previous.generation ? { generation: { ...previous.generation, version: DATASET_GENERATOR_VERSION } } : {}) });
      const count = (sql: string) => Number((this.data.db.prepare(sql).get(next.id, previous.id) as { n: number }).n);
      const addedMemories = count(`SELECT count(*) AS n FROM dataset_inputs n WHERE n.datasetId=? AND NOT EXISTS(
        SELECT 1 FROM dataset_inputs p WHERE p.datasetId=? AND p.memoryId=n.memoryId)`);
      const removedMemories = count(`SELECT count(*) AS n FROM dataset_inputs p WHERE NOT EXISTS(
        SELECT 1 FROM dataset_inputs n WHERE n.datasetId=? AND n.memoryId=p.memoryId) AND p.datasetId=?`);
      const updatedMemories = count(`SELECT count(*) AS n FROM dataset_inputs n JOIN dataset_inputs p ON n.memoryId=p.memoryId
        WHERE n.datasetId=? AND p.datasetId=? AND (n.memoryVersion<>p.memoryVersion OR EXISTS(
          SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=n.datasetId AND memoryId=n.memoryId
          EXCEPT SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=p.datasetId AND memoryId=p.memoryId)
        OR EXISTS(SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=p.datasetId AND memoryId=p.memoryId
          EXCEPT SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=n.datasetId AND memoryId=n.memoryId))`);
      const unchangedMemories = next.counts.total - addedMemories - updatedMemories;
      return this.ledger.patch(next.id, { rebuild: { datasetId: previous.id, revision: previous.revision,
        reuseSamples: previous.policy === next.policy && JSON.stringify(previous.generation) === JSON.stringify(next.generation),
        addedMemories, removedMemories, updatedMemories, unchangedMemories, reusedMemories: 0, reusedSamples: 0 } });
    });
  }

  private dependenciesMatch(datasetId: string, previousId: string, memoryId: string) {
    return !this.data.db.prepare(`SELECT 1 FROM (
      SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=? AND memoryId=?
      EXCEPT SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=? AND memoryId=?) LIMIT 1`)
      .get(datasetId, memoryId, previousId, memoryId)
      && !this.data.db.prepare(`SELECT 1 FROM (
      SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=? AND memoryId=?
      EXCEPT SELECT kind,parentId,parentVersion FROM dataset_input_dependencies WHERE datasetId=? AND memoryId=?) LIMIT 1`)
      .get(previousId, memoryId, datasetId, memoryId);
  }
  private copy(job: MemoryDataset, row: SampleRow, id: string) {
    if (this.data.db.prepare("SELECT 1 FROM dataset_samples WHERE id=?").get(id)) return false;
    const sample = JSON.parse(row.data) as TrainingSample;
    this.ledger.saveSample({ ...sample, id, datasetId: job.id, version: 1, status: row.status, stale: false,
      ...(sample.evaluationOf ? { evaluationOf: { id: datasetSampleId(job.id, "reuse", [sample.evaluationOf.id]), version: 1 } } : {}),
      reusedFrom: { datasetId: job.rebuild!.datasetId, sampleId: sample.id, version: row.version },
      checks: [...sample.checks.filter((check) => check !== "unchanged-source-reuse-v1"), "unchanged-source-reuse-v1"] });
    return true;
  }
  reuse(job: MemoryDataset, input: DatasetInput, memory: MemoryEntry, contentKey: string) {
    if (!job.rebuild?.reuseSamples) return false;
    const previousId = job.rebuild.datasetId;
    if (!this.dependenciesMatch(job.id, previousId, memory.id)) return false;
    const rows = this.data.db.prepare(`SELECT s.data,s.version,s.status FROM dataset_samples s
      JOIN dataset_sample_dependencies d ON d.sampleId=s.id
      WHERE s.datasetId=? AND s.stale=0 AND d.kind='memory' AND d.parentId=? AND d.parentVersion=?
      AND json_array_length(json_extract(s.data,'$.memoryRefs'))=1 ORDER BY s.id`)
      .all(previousId, memory.id, String(memory.version)) as SampleRow[];
    if (!rows.length) return false;
    if (rows.some((row) => {
      const sample = JSON.parse(row.data) as TrainingSample;
      if (!sample.evaluationOf) return false;
      const training = rows.find((candidate) => JSON.parse(candidate.data).id === sample.evaluationOf!.id);
      return !training || training.version !== sample.evaluationOf.version;
    })) return false;
    return this.data.memories.transaction(() => {
      for (const row of rows) {
        const sample = JSON.parse(row.data) as TrainingSample;
        this.copy(job, row, datasetSampleId(job.id, "reuse", [sample.id]));
      }
      const status = rows.some((row) => row.status === "review") ? "review" : rows.some((row) => row.status === "ready") ? "ready" : "excluded";
      this.ledger.inputState(input, status, status === "excluded" ? "沿用未变更来源的样本排除决定" : undefined);
      this.data.db.prepare("INSERT OR IGNORE INTO dataset_unique_content VALUES(?,?,?)").run(job.id, contentKey, memory.id);
      const rebuild = this.ledger.get(job.id).rebuild!;
      this.ledger.patch(job.id, { rebuild: { ...rebuild, reusedMemories: rebuild.reusedMemories + 1, reusedSamples: rebuild.reusedSamples + rows.length } });
      return true;
    });
  }
  reuseCombinations(job: MemoryDataset) {
    if (!job.rebuild?.reuseSamples) return;
    const rows = this.data.db.prepare(`SELECT data,version,status FROM dataset_samples
      WHERE datasetId=? AND stale=0 AND json_extract(data,'$.kind')='combination'`).all(job.rebuild.datasetId) as SampleRow[];
    this.data.memories.transaction(() => {
      let copied = 0;
      const affected = new Set<string>();
      for (const row of rows) {
        const sample = JSON.parse(row.data) as TrainingSample;
        if (!sample.memoryRefs.every((ref) => this.dependenciesMatch(job.id, job.rebuild!.datasetId, ref.id)
          && this.data.db.prepare(`SELECT 1 FROM dataset_sample_dependencies d JOIN dataset_samples s ON s.id=d.sampleId
            WHERE s.datasetId=? AND s.stale=0 AND d.kind='memory' AND d.parentId=? AND d.parentVersion=? LIMIT 1`)
            .get(job.id, ref.id, String(ref.version)))) continue;
        if (!this.copy(job, row, datasetSampleId(job.id, "combination", sample.memoryRefs.map((ref) => ref.id)))) continue;
        copied++;
        for (const ref of sample.memoryRefs) affected.add(ref.id);
      }
      if (!copied) return;
      for (const memoryId of affected) {
        const counts = this.data.db.prepare(`SELECT sum(s.status='review') AS review,sum(s.status='ready') AS ready
          FROM dataset_samples s JOIN dataset_sample_dependencies d ON d.sampleId=s.id
          WHERE s.datasetId=? AND s.stale=0 AND d.kind='memory' AND d.parentId=?`).get(job.id, memoryId) as { review: number; ready: number };
        this.data.db.prepare("UPDATE dataset_inputs SET status=?,reason=? WHERE datasetId=? AND memoryId=?")
          .run(counts.review ? "review" : counts.ready ? "ready" : "excluded", counts.review || counts.ready ? null : "沿用未变更来源的样本排除决定", job.id, memoryId);
      }
      const rebuild = this.ledger.get(job.id).rebuild!;
      this.ledger.patch(job.id, { rebuild: { ...rebuild, reusedSamples: rebuild.reusedSamples + copied } });
    });
  }
}
