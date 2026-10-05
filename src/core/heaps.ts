import type { Sample } from "./types.js";

type Cmp = (a: Sample, b: Sample) => boolean;

/**
 * 数组二叉堆。比较顺序：先按 value，再按 seq 打破平局，
 * 保证相同数值的不同样本永远不会被混淆。
 */
export class BinaryHeap {
  private nodes: Sample[] = [];

  constructor(private readonly better: Cmp) {}

  get physicalSize(): number {
    return this.nodes.length;
  }

  peek(): Sample | null {
    return this.nodes[0] ?? null;
  }

  push(node: Sample): void {
    this.nodes.push(node);
    this.siftUp(this.nodes.length - 1);
  }

  pop(): Sample | null {
    const top = this.nodes[0];
    if (top === undefined) return null;
    const last = this.nodes.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.nodes = [];
  }

  /** 仅供重建使用：枚举当前物理节点。 */
  rawNodes(): readonly Sample[] {
    return this.nodes;
  }

  private siftUp(i: number): void {
    const node = this.nodes[i]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pNode = this.nodes[parent]!;
      if (!this.better(node, pNode)) break;
      this.nodes[i] = pNode;
      i = parent;
    }
    this.nodes[i] = node;
  }

  private siftDown(i: number): void {
    const n = this.nodes.length;
    const node = this.nodes[i]!;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < n && this.better(this.nodes[l]!, this.nodes[best]!)) best = l;
      if (r < n && this.better(this.nodes[r]!, this.nodes[best]!)) best = r;
      if (best === i) break;
      this.nodes[i] = this.nodes[best]!;
      this.nodes[best] = node;
      i = best;
    }
  }
}

/** 最大堆：value 更大者优先，平局 seq 更大者优先。 */
export function maxHeap(): BinaryHeap {
  return new BinaryHeap(
    (a, b) => a.value > b.value || (a.value === b.value && a.seq > b.seq),
  );
}

/** 最小堆：value 更小者优先，平局 seq 更小者优先。 */
export function minHeap(): BinaryHeap {
  return new BinaryHeap(
    (a, b) => a.value < b.value || (a.value === b.value && a.seq < b.seq),
  );
}
