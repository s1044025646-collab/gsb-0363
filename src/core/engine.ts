import { BinaryHeap, maxHeap, minHeap } from "./heaps.js";
import type {
  HeapStats,
  RebalanceAction,
  RebuildRecord,
  Sample,
  Side,
  StepReport,
} from "./types.js";

/**
 * 定期重建倍数：当两堆物理节点总数 > REBUILD_FACTOR * W 时，
 * 用当前有效窗口样本（至多 W 个）重建两堆，保证长期状态有界。
 */
export const REBUILD_FACTOR = 4;

interface SideState {
  heap: BinaryHeap;
  /** 有效长度：只统计尚未滑出窗口的节点，绝不使用堆的物理长度代替。 */
  validSize: number;
}

export class MedianWindow {
  readonly windowSize: number;
  /** 按接收序号排列的有效样本环形队列（逻辑上即最近 W 个）。 */
  private window: Sample[] = [];
  private head = 0;
  private nextSeq = 1;
  private low: SideState = { heap: maxHeap(), validSize: 0 };
  private high: SideState = { heap: minHeap(), validSize: 0 };
  /** seq -> 该样本当前所在半区（0/1）；过期样本查询返回 false。 */
  private sideOfSeq = new Map<number, Side>();
  private evictedPhysicalNodes = 0;
  private rebuildHistory: RebuildRecord[] = [];

  constructor(windowSize: number, initial?: Sample[]) {
    this.windowSize = windowSize;
    if (initial && initial.length > 0) {
      // 重启恢复：只重建当前有效窗口，不恢复任何过期物理垃圾节点。
      const sorted = [...initial].sort((a, b) => a.seq - b.seq);
      for (const s of sorted) {
        this.window.push(s);
        this.nextSeq = Math.max(this.nextSeq, s.seq + 1);
      }
      this.rebuildHeapsFromWindow("physical_cap_threshold", true);
      this.rebuildHistory = [];
    }
  }

  get processedCount(): number {
    return this.nextSeq - 1;
  }

  get validSamples(): Sample[] {
    const out: Sample[] = [];
    for (let i = 0; i < this.window.length; i++) {
      out.push(this.window[(this.head + i) % this.capacity()]!);
    }
    return out;
  }

  private capacity(): number {
    return this.windowSize;
  }

  private isAlive(seq: number): boolean {
    return this.sideOfSeq.has(seq);
  }

  /**
   * 读取某堆边界前，必须先弹出堆顶所有已过期节点（惰性删除）。
   * 弹出的物理节点计入 evictedPhysicalNodes，作为清理证据。
   */
  private prune(side: SideState, actions: RebalanceAction[], from: Side): Sample | null {
    let top = side.heap.peek();
    while (top !== null && !this.isAlive(top.seq)) {
      side.heap.pop();
      this.evictedPhysicalNodes += 1;
      actions.push({ kind: "expire", from, to: null, seq: top.seq, value: top.value });
      top = side.heap.peek();
    }
    return top;
  }

  private popValid(side: SideState, from: Side, actions: RebalanceAction[]): Sample {
    const node = this.prune(side, actions, from);
    if (node === null) throw new Error("不变量被破坏：期望取出有效节点但堆为空");
    side.heap.pop();
    side.validSize -= 1;
    return node;
  }

  /** 追加一个样本并返回完整解释报告。 */
  append(value: number): StepReport {
    const sample: Sample = { seq: this.nextSeq++, value };
    const actions: RebalanceAction[] = [];
    const expired: Sample[] = [];

    // 1. 窗口已满：最旧样本滑出。
    let leaving: Sample | null = null;
    if (this.window.length === this.capacity()) {
      leaving = this.window[this.head]!;
      this.window[this.head] = sample;
      this.head = (this.head + 1) % this.capacity();
      // 逻辑删除：若它在堆顶会被 prune 立刻物理移除，否则留待惰性清理/重建。
      const side = this.sideOfSeq.get(leaving.seq);
      if (side !== undefined) {
        (side === 0 ? this.low : this.high).validSize -= 1;
        this.sideOfSeq.delete(leaving.seq);
      }
      expired.push(leaving);
    } else {
      this.window.push(sample);
    }

    // 2. 插入：以 low 边界为界，值小于等于边界入低半区，否则入高半区。
    const lowTop = this.prune(this.low, actions, 0);
    const target: Side = lowTop !== null && value > lowTop.value ? 1 : 0;
    const targetSide = target === 0 ? this.low : this.high;
    targetSide.heap.push(sample);
    targetSide.validSize += 1;
    this.sideOfSeq.set(sample.seq, target);

    // 3. 再平衡：low 有效数量必须等于 high，或恰好多一。
    this.rebalance(actions);

    // 4. 定期重建：物理节点总数超过固定倍数窗口容量时触发。
    let rebuild: RebuildRecord | null = null;
    const physicalTotal = this.low.heap.physicalSize + this.high.heap.physicalSize;
    if (physicalTotal > REBUILD_FACTOR * this.windowSize) {
      rebuild = this.rebuildHeapsFromWindow("physical_cap_threshold", false);
    }

    return this.snapshot(sample, expired, actions, rebuild);
  }

  private rebalance(actions: RebalanceAction[]): void {
    // 读取边界前清理过期节点
    this.prune(this.low, actions, 0);
    this.prune(this.high, actions, 1);

    if (this.low.validSize > this.high.validSize + 1) {
      // low 多了不止一个：最大堆顶移到 high
      const node = this.popValid(this.low, 0, actions);
      this.high.heap.push(node);
      this.high.validSize += 1;
      this.sideOfSeq.set(node.seq, 1);
      actions.push({ kind: "move", from: 0, to: 1, seq: node.seq, value: node.value });
    } else if (this.high.validSize > this.low.validSize) {
      // high 比 low 多：最小堆顶移到 low
      const node = this.popValid(this.high, 1, actions);
      this.low.heap.push(node);
      this.low.validSize += 1;
      this.sideOfSeq.set(node.seq, 0);
      actions.push({ kind: "move", from: 1, to: 0, seq: node.seq, value: node.value });
    }

    // 移动后需保证边界有序（平局由 seq 打破，插入规则保证仅一次移动即可，
    // 但极端情况下重复校验一次，确保 lowBoundary <= highBoundary）。
    const lt = this.prune(this.low, actions, 0);
    const ht = this.prune(this.high, actions, 1);
    if (lt !== null && ht !== null && lt.value > ht.value) {
      const a = this.popValid(this.low, 0, actions);
      const b = this.popValid(this.high, 1, actions);
      this.high.heap.push(a);
      this.high.validSize += 1;
      this.sideOfSeq.set(a.seq, 1);
      this.low.heap.push(b);
      this.low.validSize += 1;
      this.sideOfSeq.set(b.seq, 0);
      actions.push({ kind: "move", from: 0, to: 1, seq: a.seq, value: a.value });
      actions.push({ kind: "move", from: 1, to: 0, seq: b.seq, value: b.value });
    }
  }

  private rebuildHeapsFromWindow(
    reason: RebuildRecord["reason"],
    isRestore: boolean,
  ): RebuildRecord | null {
    const beforeLow = this.low.heap.physicalSize;
    const beforeHigh = this.high.heap.physicalSize;

    const valid = this.validSamples;
    this.low.heap.clear();
    this.high.heap.clear();
    this.sideOfSeq.clear();
    this.low.validSize = 0;
    this.high.validSize = 0;

    // 用当前有效样本排序后直接切成两半，重建后不变量天然成立。
    const sorted = [...valid].sort((a, b) =>
      a.value === b.value ? a.seq - b.seq : a.value - b.value,
    );
    const cut = Math.ceil(sorted.length / 2);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      if (i < cut) {
        this.low.heap.push(s);
        this.low.validSize += 1;
        this.sideOfSeq.set(s.seq, 0);
      } else {
        this.high.heap.push(s);
        this.high.validSize += 1;
        this.sideOfSeq.set(s.seq, 1);
      }
    }

    if (isRestore) return null;
    const record: RebuildRecord = {
      reason,
      threshold: REBUILD_FACTOR * this.windowSize,
      rebuildFactor: REBUILD_FACTOR,
      beforeLowPhysical: beforeLow,
      beforeHighPhysical: beforeHigh,
      afterLowPhysical: this.low.heap.physicalSize,
      afterHighPhysical: this.high.heap.physicalSize,
    };
    this.rebuildHistory.push(record);
    return record;
  }

  private snapshot(
    appended: Sample,
    expired: Sample[],
    actions: RebalanceAction[],
    rebuild: RebuildRecord | null,
  ): StepReport {
    const lowBoundary = this.prune(this.low, actions, 0);
    const highBoundary = this.prune(this.high, actions, 1);
    const n = this.low.validSize + this.high.validSize;

    let median: number | null = null;
    let numerator: number | null = null;
    let denominator: 1 | 2 | null = null;
    if (n > 0 && lowBoundary !== null) {
      if (n % 2 === 1) {
        median = lowBoundary.value;
        numerator = lowBoundary.value;
        denominator = 1;
      } else if (highBoundary !== null) {
        numerator = lowBoundary.value + highBoundary.value;
        denominator = 2;
        median = numerator / 2; // 精确半整数，JS 安全整数范围内无精度损失
      }
    }

    const full = this.window.length === this.capacity();
    const range =
      n === 0
        ? null
        : {
            firstSeq: this.window[this.head]!.seq,
            lastSeq:
              this.window[(this.head + this.window.length - 1) % this.capacity()]!.seq,
          };

    return {
      appended,
      expired,
      windowFull: full,
      windowRange: range,
      lowValidSize: this.low.validSize,
      highValidSize: this.high.validSize,
      lowPhysicalSize: this.low.heap.physicalSize,
      highPhysicalSize: this.high.heap.physicalSize,
      lowBoundary,
      highBoundary,
      median,
      medianNumerator: numerator,
      medianDenominator: denominator,
      rebalances: actions,
      rebuild,
    };
  }

  getStats(): HeapStats {
    return {
      lowValidSize: this.low.validSize,
      highValidSize: this.high.validSize,
      lowPhysicalSize: this.low.heap.physicalSize,
      highPhysicalSize: this.high.heap.physicalSize,
      validTotal: this.low.validSize + this.high.validSize,
      evictedPhysicalNodes: this.evictedPhysicalNodes,
      rebuilds: [...this.rebuildHistory],
    };
  }
}
