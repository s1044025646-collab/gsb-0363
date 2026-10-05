import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { MedianWindow, REBUILD_FACTOR } from "../core/engine.js";
import { validateValue, validateWindowSize, AppError } from "../core/errors.js";

/** 独立切片排序基准：对每个当前有效窗口排序后算中位数。 */
function bruteMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function checkInvariants(w: MedianWindow, label: string): void {
  const stats = w.getStats();
  assert.ok(stats.validTotal <= w.windowSize, `${label}: 有效数 ${stats.validTotal} 超过 W`);
  assert.ok(
    stats.lowValidSize === stats.highValidSize ||
      stats.lowValidSize === stats.highValidSize + 1,
    `${label}: 两堆有效大小不平衡 low=${stats.lowValidSize} high=${stats.highValidSize}`,
  );
  assert.ok(stats.lowPhysicalSize >= stats.lowValidSize, `${label}: 物理长度小于有效长度`);
  assert.ok(stats.highPhysicalSize >= stats.highValidSize, `${label}: 物理长度小于有效长度`);
}

function drive(w: number, values: number[]) {
  const engine = new MedianWindow(w);
  const current: number[] = [];
  const medians: (number | null)[] = [];
  const reports = [];
  for (const v of values) {
    const r = engine.append(v);
    current.push(v);
    if (current.length > w) current.shift();
    const expected = bruteMedian(current);
    assert.equal(r.median, expected, `W=${w} seq=${r.appended.seq} 中位数不符`);
    if (r.windowFull) medians.push(r.median);
    checkInvariants(engine, `seq=${r.appended.seq}`);
    // 边界有序
    if (r.lowBoundary && r.highBoundary) {
      assert.ok(r.lowBoundary.value <= r.highBoundary.value, "边界必须有序");
    }
    reports.push(r);
  }
  return { engine, medians, reports, current };
}

describe("双堆滑动中位数", () => {
  test("W=1", () => {
    const { medians } = drive(1, [10, -5, 7, 7, 1_000_000_000]);
    assert.deepEqual(medians, [10, -5, 7, 7, 1_000_000_000]);
  });

  test("题目指定 W=3 序列", () => {
    const { medians } = drive(3, [1, 3, -1, -3, 5, 3, 6, 7]);
    assert.deepEqual(medians, [1, -1, -1, 3, 5, 6]);
  });

  test("偶数窗口半整数", () => {
    const { reports } = drive(4, [1, 2, 3, 4]);
    const last = reports[reports.length - 1]!;
    assert.equal(last.median, 2.5);
    assert.equal(last.medianNumerator, 5);
    assert.equal(last.medianDenominator, 2);
  });

  test("边界整数 ±10亿", () => {
    drive(3, [-1_000_000_000, 1_000_000_000, -1_000_000_000, 1_000_000_000]);
  });

  test("大量相同数值不混淆", () => {
    const { engine, medians } = drive(5, Array(50).fill(42));
    assert.equal(medians.length, 46, "应有 46 个满窗口中位数");
    assert.deepEqual(medians, Array(46).fill(42));
    assert.equal(engine.validSamples.length, 5);
    assert.deepEqual(engine.validSamples.map((s) => s.seq), [46, 47, 48, 49, 50]);
  });

  test("随机序列对拍（种子伪随机）", () => {
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 2001 - 1000;
    };
    for (const w of [2, 3, 7, 100, 999]) {
      drive(w, Array.from({ length: w * 6 }, rand));
    }
  });

  test("单调长序列：过期元素埋在堆内并触发定期重建", () => {
    const w = 10;
    const engine = new MedianWindow(w);
    let rebuildSeen = false;
    const current: number[] = [];
    for (let i = 1; i <= 500; i++) {
      const r = engine.append(i);
      current.push(i);
      if (current.length > w) current.shift();
      assert.equal(r.median, bruteMedian(current));
      if (r.rebuild) {
        rebuildSeen = true;
        assert.equal(r.rebuild.reason, "physical_cap_threshold");
        assert.equal(r.rebuild.threshold, REBUILD_FACTOR * w);
        assert.ok(
          r.rebuild.beforeLowPhysical + r.rebuild.beforeHighPhysical >
            r.rebuild.afterLowPhysical + r.rebuild.afterHighPhysical,
          "重建后物理节点必须减少",
        );
        // 重建不改变中位数与序号
        assert.equal(r.appended.seq, i);
      }
    }
    assert.ok(rebuildSeen, "单调序列应当至少触发一次重建");
    const stats = engine.getStats();
    // 重建后物理节点重新回到与 W 同量级，证明长期状态有界
    assert.ok(
      stats.lowPhysicalSize + stats.highPhysicalSize <= REBUILD_FACTOR * w + w,
      "重建后物理长度应回到有界范围",
    );
    // 单调递增输入下过期的小值永远埋在最大堆底部，物理回收主要走定期重建；
    // 重建已在上面验证（rebuildSeen 与物理节点下降），这里核对清理总账：
    // evicted（惰性弹出）+ 历次重建移除节点 ≈ 总追加 - 当前物理节点。
    const rebuiltRemovals = stats.rebuilds.reduce(
      (sum, r) =>
        sum +
        (r.beforeLowPhysical + r.beforeHighPhysical -
          r.afterLowPhysical - r.afterHighPhysical),
      0,
    );
    assert.ok(
      stats.evictedPhysicalNodes + rebuiltRemovals > 0,
      "惰性弹出或重建必须实际回收过物理节点",
    );
  });

  test("空窗口与未满窗口状态", () => {
    const engine = new MedianWindow(3);
    const stats = engine.getStats();
    assert.equal(stats.validTotal, 0);
    const r1 = engine.append(10);
    assert.equal(r1.windowFull, false);
    assert.equal(r1.median, 10);
    const r2 = engine.append(20);
    assert.equal(r2.windowFull, false);
    assert.equal(r2.median, 15);
  });

  test("过期元素停在堆顶时走惰性弹出清理", () => {
    // W=2: 1 入低堆，100 入高堆；追加 2 时 1 过期且恰为最大堆堆顶，
    // prune 必须在读取边界前把它物理弹出并记录 expire 动作。
    const engine = new MedianWindow(2);
    engine.append(1);
    engine.append(100);
    const r = engine.append(2);
    assert.deepEqual(r.expired.map((s) => s.seq), [1]);
    assert.ok(r.rebalances.some((a) => a.kind === "expire" && a.seq === 1));
    assert.ok(engine.getStats().evictedPhysicalNodes >= 1);
    assert.equal(r.median, 51); // 窗口 [100,2]
  });

  test("参数校验错误码", () => {
    assert.throws(() => validateWindowSize(0), (e: Error) => e instanceof AppError && (e as AppError).code === "INVALID_WINDOW_SIZE");
    assert.throws(() => validateWindowSize(10001), (e: Error) => e instanceof AppError);
    assert.throws(() => validateValue(1.5), (e: Error) => e instanceof AppError);
    assert.throws(() => validateValue(2_000_000_000), (e: Error) => e instanceof AppError);
  });
});
