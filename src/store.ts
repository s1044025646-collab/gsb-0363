import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppendReport } from './median';

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_size INTEGER NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS samples (
        run_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        value INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS results (
        run_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        report TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS batches (
        run_id INTEGER NOT NULL,
        batch_id TEXT NOT NULL,
        report TEXT NOT NULL,
        PRIMARY KEY (run_id, batch_id)
      );
      CREATE TABLE IF NOT EXISTS rebuilds (
        run_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        reason TEXT NOT NULL,
        before_nodes INTEGER NOT NULL,
        after_nodes INTEGER NOT NULL
      );
    `);
  }

  createRun(windowSize: number): number {
    const r = this.db.prepare('INSERT INTO runs (window_size) VALUES (?)').run(windowSize);
    return Number(r.lastInsertRowid);
  }

  getRun(runId: number): { id: number; window_size: number; last_seq: number } | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as any;
  }

  /** 批量追加，整体事务：任何一笔失败全部回滚。batchId 重复时直接返回已存结果（幂等重试）。 */
  appendBatch(runId: number, batchId: string | null, values: number[], apply: (v: number) => AppendReport): AppendReport[] {
    if (batchId !== null) {
      const existing = this.db.prepare('SELECT report FROM batches WHERE run_id = ? AND batch_id = ?').get(runId, batchId) as any;
      if (existing) return JSON.parse(existing.report);
    }
    const reports: AppendReport[] = [];
    this.db.exec('BEGIN');
    try {
      for (const v of values) {
        const report = apply(v);
        reports.push(report);
        this.db.prepare('INSERT INTO samples (run_id, seq, value) VALUES (?, ?, ?)').run(runId, report.seq, v);
        this.db.prepare('INSERT INTO results (run_id, seq, report) VALUES (?, ?, ?)').run(runId, report.seq, JSON.stringify(report));
        if (report.rebuild) {
          this.db.prepare('INSERT INTO rebuilds (run_id, seq, reason, before_nodes, after_nodes) VALUES (?, ?, ?, ?, ?)')
            .run(runId, report.rebuild.seq, report.rebuild.reason, report.rebuild.beforeNodes, report.rebuild.afterNodes);
        }
      }
      const lastSeq = reports[reports.length - 1].seq;
      this.db.prepare('UPDATE runs SET last_seq = ? WHERE id = ?').run(lastSeq, runId);
      if (batchId !== null) {
        this.db.prepare('INSERT INTO batches (run_id, batch_id, report) VALUES (?, ?, ?)').run(runId, batchId, JSON.stringify(reports));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return reports;
  }

  /** 有效窗口样本（用于重启恢复） */
  loadWindowSamples(runId: number): { seq: number; value: number }[] {
    const run = this.getRun(runId);
    if (!run) return [];
    return this.db.prepare(
      'SELECT seq, value FROM samples WHERE run_id = ? AND seq > ? ORDER BY seq'
    ).all(runId, run.last_seq - run.window_size) as any;
  }

  getResult(runId: number, seq: number): AppendReport | null {
    const row = this.db.prepare('SELECT report FROM results WHERE run_id = ? AND seq = ?').get(runId, seq) as any;
    return row ? JSON.parse(row.report) : null;
  }

  listResults(runId: number, limit: number, offset: number): AppendReport[] {
    const rows = this.db.prepare('SELECT report FROM results WHERE run_id = ? ORDER BY seq LIMIT ? OFFSET ?')
      .all(runId, limit, offset) as any[];
    return rows.map((r) => JSON.parse(r.report));
  }

  listRebuilds(runId: number): unknown[] {
    return this.db.prepare('SELECT seq, reason, before_nodes AS beforeNodes, after_nodes AS afterNodes FROM rebuilds WHERE run_id = ? ORDER BY seq').all(runId) as any[];
  }

  countSamples(runId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM samples WHERE run_id = ?').get(runId) as any;
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
