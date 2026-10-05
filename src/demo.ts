import { MedianWindow } from "./core/engine.js";
import type { StepReport } from "./core/types.js";

function line(t: string): void {
  console.log("\n" + "=".repeat(64) + `\n${t}\n` + "=".repeat(64));
}

function show(r: StepReport): void {
  const range = r.windowRange ? `#${r.windowRange.firstSeq}..#${r.windowRange.lastSeq}` : "空";
  const median =
    r.medianNumerator === null
      ? "无数据"
      : r.medianDenominator === 2
        ? `${r.medianNumerator}/2 = ${r.median}`
        : `${r.median}`;
  const moves = r.rebalances
    .map((a) => (a.kind === "expire" ? `清理过期#${a.seq}` : `移动#${a.seq}(${a.from}→${a.to})`))
    .join(", ");
  console.log(
    `追加 #${r.appended.seq}=${r.appended.value} | 窗口${r.windowFull ? "已满" : "未满"} ${range} | ` +
      `有效 low=${r.lowValidSize} high=${r.highValidSize} 物理 low=${r.lowPhysicalSize} high=${r.highPhysicalSize} | ` +
      `中位数=${median}${moves ? ` | ${moves}` : ""}${r.rebuild ? ` | ★重建:${r.rebuild.beforeLowPhysical + r.rebuild.beforeHighPhysical}→${r.rebuild.afterLowPhysical + r.rebuild.afterHighPhysical}` : ""}`,
  );
}

function runSequence(title: string, w: number, values: number[]): void {
  line(title);
  const engine = new MedianWindow(w);
  for (const v of values) show(engine.append(v));
  console.log("最终统计:", JSON.stringify(engine.getStats()));
}

line("演示 1：W=3，题目指定序列 1,3,-1,-3,5,3,6,7（满窗口中位数应为 1,-1,-1,3,5,6）");
runSequence("W=3", 3, [1, 3, -1, -3, 5, 3, 6, 7]);

line("演示 2：W=4 偶数窗口（中位数取中间两数平均，允许半整数）");
runSequence("W=4", 4, [1, 2, 3, 4, 100, 5]);

line("演示 3：大量重复值 W=3");
runSequence("重复值 W=3", 3, [5, 5, 5, 5, 5, 5]);

line("演示 4：单调递增长序列 1..200，W=10 —— 触发物理重建阈值（4*W=40）");
runSequence("单调长序列 W=10", 10, Array.from({ length: 200 }, (_, i) => i + 1));
