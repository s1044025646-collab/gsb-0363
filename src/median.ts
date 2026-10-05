export interface RebalanceEvent {
  seq: number;
  direction: 'lo->hi' | 'hi->lo';
  value: number;
}

export interface RebuildEvent {
  seq: number;
  reason: string;
  beforeNodes: number;
  afterNodes: number;
}

export interface AppendReport {
  seq: number;
  value: number;
  evictedSeq: number | null;
  evictedValue: number | null;
  loValid: number;
  hiValid: number;
  loPhysical: number;
  hiPhysical: number;
  loBoundary: number | null;
  hiBoundary: number | null;
  median: number | null;
  windowLo: number;
  windowHi: number;
  windowFull: boolean;
  rebalances: RebalanceEvent[];
  rebuild: RebuildEvent | null;
}

import { Heap, Entry } from './heap';

/** 物理节点数超过 W * REBUILD_FACTOR 时触发重建 */
export const REBUILD_FACTOR = 2;

export class SlidingMedian {
  private lo = new Heap('max'); // 较小一半
  private hi = new Heap('min'); // 较大一半
  private loValid = 0;
  private hiValid = 0;
  private lastSeq = 0;
  private values = new Map<number, number>(); // seq -> value，仅保留有效窗口
  readonly rebuildLog: RebuildEvent[] = [];

  constructor(public readonly windowSize: number) {
    if (!Number.isInteger(windowSize) || windowSize < 1 || windowSize > 10000) {
      throw new Error('INVALID_WINDOW: windowSize 必须是 1..10000 的整数');
    }
  }

  private isExpired(e: Entry): boolean {
    return e.seq <= this.lastSeq - this.windowSize;
  }

  /** 读取边界或移动堆顶前必须清理已过期元素 */
  private cleanTops(): void {
    this.lo.cleanTop((e) => this.isExpired(e));
    this.hi.cleanTop((e) => this.isExpired(e));
  }

  get validCount(): number {
    return this.loValid + this.hiValid;
  }

  get physicalCount(): number {
    return this.lo.length + this.hi.length;
  }

  append(value: number): AppendReport {
    if (!Number.isInteger(value) || value < -1e9 || value > 1e9) {
      throw new Error('INVALID_VALUE: value 必须是 [-1e9, 1e9] 内的整数');
    }
    this.lastSeq++;
    const seq = this.lastSeq;
    const entry: Entry = { value, seq };
    this.values.set(seq, value);

    const rebalances: RebalanceEvent[] = [];

    // 过期元素离开窗口（按序号，唯一）
    const evictedSeq = seq - this.windowSize;
    let evictedValue: number | null = null;
    if (evictedSeq > 0 && this.values.has(evictedSeq)) {
      evictedValue = this.values.get(evictedSeq)!;
      this.values.delete(evictedSeq);
      // 上一步结束时堆顶已清理，每步只有一个新过期元素，
      // 因此堆顶若非有效即为本步过期元素，可据此精确判定归属。
      const loTop = this.lo.peek();
      const hiTop = this.hi.peek();
      let inLo: boolean;
      if (loTop !== undefined && loTop.seq === evictedSeq) inLo = true;
      else if (hiTop !== undefined && hiTop.seq === evictedSeq) inLo = false;
      else if (this.loValid === 0) inLo = false;
      else if (this.hiValid === 0) inLo = true;
      else inLo = evictedValue <= loTop!.value;
      if (inLo) this.loValid--;
      else this.hiValid--;
    }

    // 插入新元素：与有效边界比较决定归属，保证两边边界有序
    this.cleanTops();
    const threshold =
      this.loValid > 0 ? this.lo.peek()!.value : this.hiValid > 0 ? this.hi.peek()!.value : undefined;
    if (threshold === undefined || value <= threshold) {
      this.lo.push(entry);
      this.loValid++;
    } else {
      this.hi.push(entry);
      this.hiValid++;
    }

    // 再平衡：loValid == hiValid 或 loValid == hiValid + 1
    while (this.loValid > this.hiValid + 1) {
      this.cleanTops();
      const moved = this.lo.pop()!;
      this.hi.push(moved);
      this.loValid--;
      this.hiValid++;
      rebalances.push({ seq, direction: 'lo->hi', value: moved.value });
    }
    while (this.hiValid > this.loValid) {
      this.cleanTops();
      const moved = this.hi.pop()!;
      this.lo.push(moved);
      this.hiValid--;
      this.loValid++;
      rebalances.push({ seq, direction: 'hi->lo', value: moved.value });
    }

    // 定期重建：物理节点数超过窗口容量固定倍数
    let rebuild: RebuildEvent | null = null;
    if (this.physicalCount > this.windowSize * REBUILD_FACTOR) {
      const before = this.physicalCount;
      const alive: Entry[] = [];
      for (const e of this.lo.drainAll().concat(this.hi.drainAll())) {
        if (!this.isExpired(e)) alive.push(e);
      }
      this.loValid = 0;
      this.hiValid = 0;
      for (const e of alive) {
        const top = this.lo.peek();
        if (this.loValid === 0 || (top !== undefined && e.value <= top.value)) {
          this.lo.push(e);
          this.loValid++;
        } else {
          this.hi.push(e);
          this.hiValid++;
        }
        while (this.loValid > this.hiValid + 1) {
          const m = this.lo.pop()!;
          this.hi.push(m);
          this.loValid--;
          this.hiValid++;
        }
        while (this.hiValid > this.loValid) {
          const m = this.hi.pop()!;
          this.lo.push(m);
          this.hiValid--;
          this.loValid++;
        }
      }
      rebuild = {
        seq,
        reason: `物理节点数 ${before} 超过窗口容量 ${this.windowSize} 的 ${REBUILD_FACTOR} 倍`,
        beforeNodes: before,
        afterNodes: this.physicalCount,
      };
      this.rebuildLog.push(rebuild);
    }

    this.cleanTops();
    const median = this.currentMedianInternal();
    const windowLo = Math.max(1, seq - this.windowSize + 1);
    return {
      seq,
      value,
      evictedSeq: evictedSeq > 0 ? evictedSeq : null,
      evictedValue,
      loValid: this.loValid,
      hiValid: this.hiValid,
      loPhysical: this.lo.length,
      hiPhysical: this.hi.length,
      loBoundary: this.lo.peek()?.value ?? null,
      hiBoundary: this.hi.peek()?.value ?? null,
      median,
      windowLo,
      windowHi: seq,
      windowFull: this.validCount === this.windowSize,
      rebalances,
      rebuild,
    };
  }

  private currentMedianInternal(): number | null {
    if (this.validCount === 0) return null;
    this.cleanTops();
    const loTop = this.lo.peek()!.value;
    if (this.loValid > this.hiValid) return loTop;
    return (loTop + this.hi.peek()!.value) / 2; // 允许精确半整数
  }

  currentMedian(): number | null {
    return this.currentMedianInternal();
  }

  snapshot() {
    this.cleanTops();
    return {
      windowSize: this.windowSize,
      lastSeq: this.lastSeq,
      validCount: this.validCount,
      loValid: this.loValid,
      hiValid: this.hiValid,
      loPhysical: this.lo.length,
      hiPhysical: this.hi.length,
      loBoundary: this.lo.peek()?.value ?? null,
      hiBoundary: this.hi.peek()?.value ?? null,
      median: this.currentMedianInternal(),
      rebuildLog: this.rebuildLog,
    };
  }

  /** 从持久化的有效样本重建（重启恢复），保留原始样本序号 */
  static restore(windowSize: number, samples: { seq: number; value: number }[]): SlidingMedian {
    const sm = new SlidingMedian(windowSize);
    if (samples.length > 0) sm.lastSeq = samples[0].seq - 1;
    for (const s of samples) sm.append(s.value);
    return sm;
  }
}
