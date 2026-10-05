export interface Entry {
  value: number;
  seq: number;
}

/** 二叉堆。kind='max' 为最大堆，'min' 为最小堆。物理数组可能含已过期节点，需调用方惰性清理。 */
export class Heap {
  private data: Entry[] = [];
  constructor(public readonly kind: 'min' | 'max') {}

  get length(): number {
    return this.data.length;
  }

  private higher(a: Entry, b: Entry): boolean {
    if (a.value !== b.value) {
      return this.kind === 'max' ? a.value > b.value : a.value < b.value;
    }
    // 值相同按序号定序，保证相同数值的不同样本不会混淆
    return this.kind === 'max' ? a.seq > b.seq : a.seq < b.seq;
  }

  push(e: Entry): void {
    this.data.push(e);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.higher(this.data[i], this.data[p])) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }

  peek(): Entry | undefined {
    return this.data[0];
  }

  pop(): Entry | undefined {
    const n = this.data.length;
    if (n === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (n > 1) {
      this.data[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.data.length && this.higher(this.data[l], this.data[best])) best = l;
        if (r < this.data.length && this.higher(this.data[r], this.data[best])) best = r;
        if (best === i) break;
        [this.data[i], this.data[best]] = [this.data[best], this.data[i]];
        i = best;
      }
    }
    return top;
  }

  /** 惰性清理堆顶：弹出所有满足 expired 的节点，返回清理数量。 */
  cleanTop(expired: (e: Entry) => boolean): number {
    let removed = 0;
    while (this.data.length > 0 && expired(this.data[0])) {
      this.pop();
      removed++;
    }
    return removed;
  }

  drainAll(): Entry[] {
    return this.data.splice(0, this.data.length);
  }
}
