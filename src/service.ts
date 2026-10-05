import { MedianWindow } from "./core/engine.js";
import { AppError, validateValue, validateWindowSize } from "./core/errors.js";
import type { HeapStats, StepReport } from "./core/types.js";
import { MedianStore } from "./store/db.js";

interface RunState {
  windowSize: number;
  engine: MedianWindow;
}

export interface CurrentState {
  runId: number;
  windowSize: number;
  processedSeq: number;
  report: StepReport | null;
  stats: HeapStats;
}

export class MedianService {
  private states = new Map<number, RunState>();

  constructor(private readonly store: MedianStore) {}

  createRun(windowSize: number): { runId: number; windowSize: number } {
    const w = validateWindowSize(windowSize);
    const row = this.store.createRun(w);
    this.states.set(row.id, { windowSize: w, engine: new MedianWindow(w) });
    return { runId: row.id, windowSize: w };
  }

  private load(runId: number): RunState {
    const cached = this.states.get(runId);
    if (cached) return cached;
    const { windowSize, samples } = this.store.loadValidSamples(runId);
    // 重启恢复：只依据保存的有效窗口重建堆；过期垃圾节点不恢复。
    const engine = new MedianWindow(
      windowSize,
      samples.map((s) => ({ seq: s.seq, value: s.value })),
    );
    const state = { windowSize, engine };
    this.states.set(runId, state);
    return state;
  }

  append(runId: number, value: number): { report: StepReport } {
    const state = this.load(runId);
    const v = validateValue(value);
    const report = state.engine.append(v);
    this.store.commitBatch(runId, null, [v], [report]);
    return { report };
  }

  appendBatch(
    runId: number,
    values: number[],
    batchId: string | null,
  ): { reports: StepReport[]; deduplicated: boolean; firstSeq: number; lastSeq: number } {
    const state = this.load(runId);
    if (!Array.isArray(values) || values.length === 0) {
      throw new AppError("EMPTY_INPUT", "批量追加至少需要一个样本");
    }
    if (values.length > 50_000) {
      throw new AppError("INVALID_BATCH", "单批样本不得超过 50000 个");
    }

    // 幂等：重试同一 batch_id 直接返回已有结果，不重复计算。
    if (batchId !== null) {
      const existing = this.store.getBatch(runId, batchId);
      if (existing) {
        const range = this.store.db
          .prepare("SELECT first_seq, last_seq FROM batches WHERE run_id = ? AND batch_id = ?")
          .get(runId, batchId) as { first_seq: number; last_seq: number };
        const rows = this.store.db
          .prepare("SELECT * FROM history WHERE run_id = ? AND seq BETWEEN ? AND ? ORDER BY seq ASC")
          .all(runId, range.first_seq, range.last_seq) as Record<string, unknown>[];
        return {
          reports: rows.map((r) => this.rowToLightReport(r)),
          deduplicated: true,
          firstSeq: range.first_seq,
          lastSeq: range.last_seq,
        };
      }
    }

    // 先全部校验，再全部计算，保证失败原子回滚、引擎状态不留半截。
    const validated = values.map((v) => validateValue(v));
    const reports: StepReport[] = [];
    for (const v of validated) reports.push(state.engine.append(v));
    const res = this.store.commitBatch(runId, batchId, validated, reports);
    return { ...res, reports };
  }

  private rowToLightReport(row: Record<string, unknown>): StepReport {
    const expired =
      row.expired_items !== undefined && String(row.expired_items) !== "[]"
        ? (JSON.parse(String(row.expired_items)) as { seq: number; value: number }[])
        : (JSON.parse(String(row.expired_seqs)) as number[]).map((seq) => ({ seq, value: 0 }));
    return {
      appended: { seq: Number(row.seq), value: Number(row.value) },
      expired,
      windowFull: Boolean(row.window_full),
      windowRange:
        row.first_seq !== null && row.first_seq !== undefined
          ? { firstSeq: Number(row.first_seq), lastSeq: Number(row.last_seq) }
          : null,
      lowValidSize: Number(row.low_valid_size),
      highValidSize: Number(row.high_valid_size),
      lowPhysicalSize: Number(row.low_physical_size ?? -1),
      highPhysicalSize: Number(row.high_physical_size ?? -1),
      lowBoundary:
        row.low_boundary_seq === null || row.low_boundary_seq === undefined
          ? null
          : { seq: Number(row.low_boundary_seq), value: Number(row.low_boundary_value) },
      highBoundary:
        row.high_boundary_seq === null || row.high_boundary_seq === undefined
          ? null
          : { seq: Number(row.high_boundary_seq), value: Number(row.high_boundary_value) },
      median: row.median === null ? null : Number(row.median),
      medianNumerator: row.median_num === null ? null : Number(row.median_num),
      medianDenominator: row.median_den === null ? null : (Number(row.median_den) as 1 | 2),
      rebalances: [],
      rebuild: null,
    };
  }

  current(runId: number): CurrentState {
    const state = this.load(runId);
    const run = this.store.requireRun(runId);
    const seq = run.processed_seq;
    let report: StepReport | null = null;
    if (seq > 0) {
      const row = this.store.db
        .prepare("SELECT * FROM history WHERE run_id = ? AND seq = ?")
        .get(runId, seq) as Record<string, unknown>;
      report = this.rowToLightReport(row);
    }
    return {
      runId,
      windowSize: state.windowSize,
      processedSeq: seq,
      report,
      stats: state.engine.getStats(),
    };
  }

  history(runId: number, seq: number) {
    return this.store.getHistory(runId, seq);
  }

  recentHistory(runId: number, limit: number, beforeSeq?: number) {
    return this.store.listHistory(runId, { limit, beforeSeq });
  }

  /** 导出完整报告：配置 + 全部历史 + 最终堆状态/重建记录。 */
  exportReport(runId: number) {
    const state = this.load(runId);
    const run = this.store.requireRun(runId);
    const history = this.store.db
      .prepare("SELECT * FROM history WHERE run_id = ? ORDER BY seq ASC")
      .all(runId) as Record<string, unknown>[];
    return {
      run: {
        id: run.id,
        windowSize: run.window_size,
        processedSeq: run.processed_seq,
        createdAt: run.created_at,
      },
      validWindow: state.engine.validSamples,
      stats: state.engine.getStats(),
      history,
    };
  }
}
