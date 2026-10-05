/** 样本：接收序号 seq 从 1 开始，按接收顺序连续递增；value 为整数。 */
export interface Sample {
  seq: number;
  value: number;
}

export type Side = 0 | 1; // 0 = 低半区最大堆，1 = 高半区最小堆

export interface RebalanceAction {
  /** move: 将一堆堆顶移动到另一堆；expire: 读取边界前清理了过期物理节点 */
  kind: "expire" | "move";
  from: Side;
  to: Side | null;
  seq: number;
  value: number;
}

export interface RebuildRecord {
  reason: "physical_cap_threshold";
  /** 触发阈值：物理节点总数超过 rebuildFactor * W */
  threshold: number;
  rebuildFactor: number;
  beforeLowPhysical: number;
  beforeHighPhysical: number;
  afterLowPhysical: number;
  afterHighPhysical: number;
}

export interface StepReport {
  appended: Sample;
  /** 本次追加导致离开窗口的样本（序号升序） */
  expired: Sample[];
  windowFull: boolean;
  windowRange: { firstSeq: number; lastSeq: number } | null;
  lowValidSize: number;
  highValidSize: number;
  lowPhysicalSize: number;
  highPhysicalSize: number;
  lowBoundary: Sample | null;
  highBoundary: Sample | null;
  /** 偶数个有效样本时为 (lowBoundary + highBoundary) / 2，分母为 2；奇数时为 lowBoundary，分母为 1 */
  median: number | null;
  medianNumerator: number | null;
  medianDenominator: 1 | 2 | null;
  rebalances: RebalanceAction[];
  rebuild: RebuildRecord | null;
}

export interface HeapStats {
  lowValidSize: number;
  highValidSize: number;
  lowPhysicalSize: number;
  highPhysicalSize: number;
  validTotal: number;
  evictedPhysicalNodes: number;
  rebuilds: RebuildRecord[];
}
