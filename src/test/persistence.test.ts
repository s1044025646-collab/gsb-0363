import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MedianService } from "../service.js";
import { MedianStore } from "../store/db.js";
import { AppError } from "../core/errors.js";

const dir = join(tmpdir(), `median-test-${process.pid}-${Date.now()}`);

describe("SQLite 持久化 / 批次 / 恢复", () => {
  let store: MedianStore;
  let service: MedianService;

  before(() => {
    store = new MedianStore(join(dir, "test.db"));
    service = new MedianService(store);
  });
  after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("单笔追加并查看当前", () => {
    const { runId } = service.createRun(3);
    service.append(runId, 1);
    service.append(runId, 3);
    const cur = service.current(runId);
    assert.equal(cur.processedSeq, 2);
    assert.equal(cur.report?.median, 2);
    assert.equal(cur.report?.windowFull, false);
  });

  test("批量失败原子回滚", () => {
    const { runId } = service.createRun(3);
    const before = service.current(runId).processedSeq;
    assert.throws(
      () => service.appendBatch(runId, [1, 2, 999999999999 as unknown as number], "batch-bad"),
      (e: Error) => e instanceof AppError && e.code === "INVALID_VALUE",
    );
    const after = service.current(runId).processedSeq;
    assert.equal(after, before, "失败批次必须整体回滚，不留部分样本");
  });

  test("batch_id 幂等重试不重复计算", () => {
    const { runId } = service.createRun(3);
    const first = service.appendBatch(runId, [1, 2, 3], "b1");
    assert.equal(first.deduplicated, false);
    assert.equal(first.lastSeq, 3);
    const retry = service.appendBatch(runId, [1, 2, 3], "b1");
    assert.equal(retry.deduplicated, true, "相同 batchId 必须走幂等分支");
    assert.equal(service.current(runId).processedSeq, 3, "重试不得多算样本");
  });

  test("重启后仅用有效窗口重建堆，结果一致", () => {
    const { runId } = service.createRun(3);
    service.appendBatch(runId, [1, 3, -1, -3, 5, 3, 6, 7], null);
    const before = service.current(runId);
    assert.equal(before.report?.median, 6);

    // 模拟重启：新建 store/service（读同一份数据库文件），不保留任何内存堆
    store.close();
    const store2 = new MedianStore(join(dir, "test.db"));
    const service2 = new MedianService(store2);
    const restored = service2.current(runId);
    assert.equal(restored.processedSeq, 8);
    assert.equal(restored.report?.median, 6);
    assert.deepEqual(
      restored.stats.validTotal,
      3,
      "恢复后有效数等于 W，过期物理垃圾不恢复",
    );
    // 恢复后继续追加，语义与连续运行一致
    const cont = service2.append(runId, 7);
    assert.equal(cont.report.median, 7); // 窗口滑为 [6,7,7] -> 中位数 7
    store2.close();
    // 重新打开供 after 清理（after 会再次 close，忽略即可）
    store = new MedianStore(join(dir, "test.db"));
    service = new MedianService(store);
  });

  test("历史按序号查询", () => {
    const { runId } = service.createRun(2);
    service.appendBatch(runId, [10, 20, 30], null);
    const h = service.history(runId, 2);
    assert.notEqual(h, null);
    assert.equal(Number(h!.value), 20);
    assert.throws(() => service.history(runId, 999), (e: Error) => e instanceof AppError && e.code === "SEQ_NOT_FOUND");
  });

  test("导出报告包含全部历史与重建统计", () => {
    const { runId } = service.createRun(10);
    const values = Array.from({ length: 200 }, (_, i) => i + 1);
    service.appendBatch(runId, values, "mono");
    const report = service.exportReport(runId);
    assert.equal((report.history as unknown[]).length, 200);
    assert.equal(report.run.processedSeq, 200);
    assert.ok(report.stats.rebuilds.length > 0, "单调长序列应产生重建记录");
  });

  test("运行不存在返回 RUN_NOT_FOUND", () => {
    assert.throws(() => service.current(999999), (e: Error) => e instanceof AppError && e.code === "RUN_NOT_FOUND");
  });
});
