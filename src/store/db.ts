import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../core/errors.js";
import type { StepReport } from "../core/types.js";

export interface RunRow {
  id: number;
  window_size: number;
  processed_seq: number;
  created_at: string;
}

export class MedianStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        window_size   INTEGER NOT NULL CHECK (window_size BETWEEN 1 AND 10000),
        processed_seq INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS samples (
        run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        value    INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS batches (
        run_id    INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        batch_id  TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        first_seq INTEGER NOT NULL,
        last_seq  INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, batch_id)
      );
      CREATE TABLE IF NOT EXISTS history (
        run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL,
        value         INTEGER NOT NULL,
        window_full   INTEGER NOT NULL,
        median        REAL,
        median_num    INTEGER,
        median_den    INTEGER,
      low_valid_size  INTEGER NOT NULL,
      high_valid_size INTEGER NOT NULL,
      low_physical_size  INTEGER NOT NULL DEFAULT 0,
      high_physical_size INTEGER NOT NULL DEFAULT 0,
      low_boundary_seq INTEGER,
      low_boundary_value INTEGER,
      high_boundary_seq INTEGER,
      high_boundary_value INTEGER,
      expired_items TEXT NOT NULL DEFAULT '[]',
      expired_seqs    TEXT NOT NULL DEFAULT '[]',
      first_seq       INTEGER,
      last_seq        INTEGER,
      rebalance_count INTEGER NOT NULL,
      rebuilt         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id);
      CREATE INDEX IF NOT EXISTS idx_history_run ON history(run_id, seq);
    `);
  }

  createRun(windowSize: number): RunRow {
    const stmt = this.db.prepare(
      "INSERT INTO runs (window_size) VALUES (?) RETURNING *",
    );
    try {
      return stmt.get(windowSize) as unknown as RunRow;
    } catch (e) {
      throw new AppError("INTERNAL_ERROR", `创建运行失败: ${String(e)}`, 500);
    }
  }

  getRun(id: number): RunRow | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as RunRow | undefined;
    return row ?? null;
  }

  requireRun(id: number): RunRow {
    const run = this.getRun(id);
    if (!run) throw new AppError("RUN_NOT_FOUND", `运行 #${id} 不存在`, 404);
    return run;
  }

  /** 重启恢复用：返回当前有效窗口样本（按 seq 升序）。 */
  loadValidSamples(runId: number): { windowSize: number; samples: { seq: number; value: number }[] } {
    const run = this.requireRun(runId);
    const rows = this.db
      .prepare("SELECT seq, value FROM samples WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as { seq: number; value: number }[];
    return { windowSize: run.window_size, samples: rows };
  }

  getBatch(runId: number, batchId: string): { item_count: number } | null {
    const row = this.db
      .prepare("SELECT item_count FROM batches WHERE run_id = ? AND batch_id = ?")
      .get(runId, batchId) as { item_count: number } | undefined;
    return row ?? null;
  }

  /**
   * 原子提交一整个批次：任何一步失败全部回滚，不留半批数据。
   * reports 必须与 values 一一对应。
   */
  commitBatch(
    runId: number,
    batchId: string | null,
    values: number[],
    reports: StepReport[],
  ): { firstSeq: number; lastSeq: number; deduplicated: boolean } {
    if (batchId !== null) {
      const existing = this.getBatch(runId, batchId);
      if (existing) {
        // 幂等重试：同一 batch_id 不重复计算，返回已有区间。
        const row = this.db
          .prepare("SELECT first_seq, last_seq FROM batches WHERE run_id = ? AND batch_id = ?")
          .get(runId, batchId) as { first_seq: number; last_seq: number };
        return { firstSeq: row.first_seq, lastSeq: row.last_seq, deduplicated: true };
      }
      if (values.length === 0) {
        throw new AppError("EMPTY_INPUT", "批次至少包含一个样本");
      }
    }

    const insSample = this.db.prepare(
      "INSERT INTO samples (run_id, seq, value) VALUES (?, ?, ?)",
    );
    const delSample = this.db.prepare(
      "DELETE FROM samples WHERE run_id = ? AND seq = ?",
    );
    const insHistory = this.db.prepare(`
      INSERT INTO history
        (run_id, seq, value, window_full, median, median_num, median_den,
         low_valid_size, high_valid_size, low_physical_size, high_physical_size,
         low_boundary_seq, low_boundary_value, high_boundary_seq, high_boundary_value,
         expired_items, expired_seqs, first_seq, last_seq, rebalance_count, rebuilt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updRun = this.db.prepare(
      "UPDATE runs SET processed_seq = ? WHERE id = ?",
    );
    const insBatch = this.db.prepare(
      "INSERT INTO batches (run_id, batch_id, item_count, first_seq, last_seq) VALUES (?, ?, ?, ?, ?)",
    );

    const tx = (): { firstSeq: number; lastSeq: number } => {
      this.db.exec("BEGIN IMMEDIATE");
      const run = this.requireRun(runId);
      let seq = run.processed_seq;
      const firstSeq = seq + 1;
      for (let i = 0; i < values.length; i++) {
        seq += 1;
        const r = reports[i]!;
        // 维护有效窗口表：写入新样本，删除本次滑出的旧样本。
        insSample.run(runId, seq, values[i]!);
        for (const ex of r.expired) delSample.run(runId, ex.seq);
        insHistory.run(
          runId,
          seq,
          values[i]!,
          r.windowFull ? 1 : 0,
          r.median,
          r.medianNumerator,
          r.medianDenominator,
          r.lowValidSize,
          r.highValidSize,
          r.lowPhysicalSize,
          r.highPhysicalSize,
          r.lowBoundary?.seq ?? null,
          r.lowBoundary?.value ?? null,
          r.highBoundary?.seq ?? null,
          r.highBoundary?.value ?? null,
          JSON.stringify(r.expired),
          JSON.stringify(r.expired.map((s) => s.seq)),
          r.windowRange?.firstSeq ?? null,
          r.windowRange?.lastSeq ?? null,
          r.rebalances.length,
          r.rebuild ? 1 : 0,
        );
      }
      updRun.run(seq, runId);
      if (batchId !== null) {
        insBatch.run(runId, batchId, values.length, firstSeq, seq);
      }
      return { firstSeq, lastSeq: seq };
    };

    try {
      const res = tx();
      this.db.exec("COMMIT");
      return { ...res, deduplicated: false };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 连接无活动事务时忽略
      }
      if (e instanceof AppError) throw e;
      throw new AppError("BATCH_CONFLICT", `批次提交失败并已回滚: ${String(e)}`, 409);
    }
  }

  getHistory(runId: number, seq: number): Record<string, unknown> | null {
    this.requireRun(runId);
    const row = this.db
      .prepare("SELECT * FROM history WHERE run_id = ? AND seq = ?")
      .get(runId, seq) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("SEQ_NOT_FOUND", `运行 #${runId} 不存在序号 ${seq}`, 404);
    return row;
  }

  listHistory(
    runId: number,
    opts: { limit: number; beforeSeq?: number },
  ): Record<string, unknown>[] {
    this.requireRun(runId);
    const limit = Math.min(Math.max(opts.limit, 1), 500);
    if (opts.beforeSeq !== undefined) {
      return this.db
        .prepare(
          "SELECT * FROM history WHERE run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
        )
        .all(runId, opts.beforeSeq, limit) as Record<string, unknown>[];
    }
    return this.db
      .prepare("SELECT * FROM history WHERE run_id = ? ORDER BY seq DESC LIMIT ?")
      .all(runId, limit) as Record<string, unknown>[];
  }
}
