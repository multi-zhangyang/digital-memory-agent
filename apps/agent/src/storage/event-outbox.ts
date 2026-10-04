import type { DatabaseSync } from "node:sqlite";

export interface DomainEvent {
  seq: number;
  topic: string;
  aggregateId: string;
  revision: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
type Consumer = { name: string; topics: string[]; handle: (event: DomainEvent) => void | Promise<void> };

/** Persist in the publisher's transaction. Delivery is at least once; consumers use stable request IDs. */
export class EventOutbox {
  private readonly consumers = new Map<string, Consumer>();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closed = false;

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS domain_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,topic TEXT NOT NULL,aggregateId TEXT NOT NULL,revision TEXT NOT NULL,
      payload TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(topic,aggregateId,revision));
      CREATE INDEX IF NOT EXISTS domain_event_topic ON domain_events(topic,seq);
      CREATE TABLE IF NOT EXISTS event_deliveries (
        consumer TEXT NOT NULL,eventSeq INTEGER NOT NULL REFERENCES domain_events(seq),
        deliveredAt TEXT,attempts INTEGER NOT NULL DEFAULT 0,retryAt INTEGER NOT NULL DEFAULT 0,error TEXT,
        PRIMARY KEY(consumer,eventSeq));`);
  }
  publish(topic: string, aggregateId: string, revision: string | number, payload: Record<string, unknown> = {}) {
    this.db.prepare("INSERT OR IGNORE INTO domain_events(topic,aggregateId,revision,payload,createdAt) VALUES (?,?,?,?,?)")
      .run(topic, aggregateId, String(revision), JSON.stringify(payload), new Date().toISOString());
  }
  subscribe(name: string, topics: string[], handle: Consumer["handle"]) {
    if (this.consumers.has(name)) throw new Error("Duplicate event consumer");
    this.consumers.set(name, { name, topics, handle });
    return () => { this.consumers.delete(name); };
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.flush(); }, 100);
    this.timer.unref();
    void this.flush();
  }
  flush() {
    if (this.closed) return Promise.resolve();
    return this.running ??= this.drain().finally(() => { this.running = undefined; });
  }
  private async drain() {
    for (const consumer of this.consumers.values()) {
      const rows = this.db.prepare(`SELECT e.* FROM domain_events e LEFT JOIN event_deliveries d ON d.eventSeq=e.seq AND d.consumer=?
        WHERE e.topic IN (SELECT value FROM json_each(?)) AND d.deliveredAt IS NULL AND coalesce(d.retryAt,0)<=?
        ORDER BY e.seq LIMIT 64`).all(consumer.name, JSON.stringify(consumer.topics), Date.now()) as unknown as (Omit<DomainEvent, "payload"> & { payload: string })[];
      for (const row of rows) {
        if (this.closed) return;
        try {
          await consumer.handle({ ...row, payload: JSON.parse(row.payload) });
          this.db.prepare(`INSERT INTO event_deliveries(consumer,eventSeq,deliveredAt,attempts) VALUES (?,?,?,1)
            ON CONFLICT(consumer,eventSeq) DO UPDATE SET deliveredAt=excluded.deliveredAt,attempts=attempts+1,error=NULL,retryAt=0`)
            .run(consumer.name, row.seq, new Date().toISOString());
        } catch {
          this.db.prepare(`INSERT INTO event_deliveries(consumer,eventSeq,attempts,retryAt,error) VALUES (?,?,1,?,'DELIVERY_FAILED')
            ON CONFLICT(consumer,eventSeq) DO UPDATE SET attempts=attempts+1,retryAt=excluded.retryAt,error=excluded.error`)
            .run(consumer.name, row.seq, Date.now() + 1000);
        }
      }
    }
  }
  status() {
    return this.db.prepare("SELECT consumer,count(*) AS pending,max(attempts) AS attempts FROM event_deliveries WHERE deliveredAt IS NULL GROUP BY consumer").all();
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
