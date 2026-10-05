import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SlidingMedian, AppendReport } from '../median';
import { Store } from '../store';
import { Service, startServer } from '../server';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  通过: ${name}`);
  } catch (e) {
    console.error(`  失败: ${name}`);
    throw e;
  }
}

/** 切片排序基准：对最近 W 个值排序取中位数 */
function oracleMedian(window: number[]): number {
  const s = [...window].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 逐步核对：中位数、有效数不超 W、边界与大小不变量 */
function checkAgainstOracle(W: number, inputs: number[]): AppendReport[] {
  const sm = new SlidingMedian(W);
  const reports: AppendReport[] = [];
  const window: number[] = [];
  for (const v of inputs) {
    const r = sm.append(v);
    window.push(v);
    if (window.length > W) window.shift();
    assert.equal(r.median, oracleMedian(window), `seq=${r.seq} 中位数不一致`);
    assert.ok(r.loValid + r.hiValid <= W, '有效数超过 W');
    assert.equal(r.loValid + r.hiValid, window.length, '有效数与窗口长度不一致');
    assert.ok(r.loValid === r.hiValid || r.loValid === r.hiValid + 1, '两堆大小不变量被破坏');
    if (r.loBoundary !== null && r.hiBoundary !== null) {
      assert.ok(r.loBoundary <= r.hiBoundary, '边界无序');
    }
    assert.equal(r.seq, reports.length + 1, '序号不连续');
    reports.push(r);
  }
  return reports;
}

async function main() {
  console.log('运行测试...');

  await test('演示用例 W=3: 1,3,-1,-3,5,3,6,7', () => {
    const reports = checkAgainstOracle(3, [1, 3, -1, -3, 5, 3, 6, 7]);
    const fullMedians = reports.filter((r) => r.windowFull).map((r) => r.median);
    assert.deepEqual(fullMedians, [1, -1, -1, 3, 5, 6]);
    assert.equal(reports[0].windowFull, false);
  });

  await test('W=1 每个样本即中位数', () => {
    const reports = checkAgainstOracle(1, [7, -3, 100, 0, -1e9, 1e9]);
    assert.deepEqual(reports.map((r) => r.median), [7, -3, 100, 0, -1e9, 1e9]);
  });

  await test('边界整数 ±1e9 与半整数', () => {
    const reports = checkAgainstOracle(2, [1e9, -1e9, 1e9, 1e9 - 1]);
    assert.equal(reports[1].median, 0);
    assert.equal(reports[3].median, 1e9 - 0.5);
  });

  await test('大量相同数值不混淆', () => {
    const inputs = Array(500).fill(42).concat([1, 2, 3]);
    const reports = checkAgainstOracle(7, inputs);
    assert.equal(reports[reports.length - 1].median, 42);
  });

  await test('过期元素埋在堆内（交替高低输入）', () => {
    const inputs: number[] = [];
    for (let i = 0; i < 2000; i++) inputs.push(i % 2 === 0 ? 1e9 : -1e9);
    checkAgainstOracle(50, inputs);
  });

  await test('单调长序列触发重建且状态有界', () => {
    const W = 100;
    const inputs = Array.from({ length: 50000 }, (_, i) => i + 1);
    const reports = checkAgainstOracle(W, inputs);
    const rebuilds = reports.filter((r) => r.rebuild).map((r) => r.rebuild!);
    assert.ok(rebuilds.length > 100, '单调输入应触发多次重建');
    for (const rb of rebuilds) {
      assert.ok(rb.beforeNodes > W * 2, '重建阈值正确');
      assert.ok(rb.afterNodes <= W, '重建后节点数不超过 W');
    }
    const last = reports[reports.length - 1];
    assert.ok(last.loPhysical + last.hiPhysical <= W * 2 + 1, '长期状态有界');
    assert.equal(last.median, 50000 - 49.5);
  });

  await test('随机输入对照基准（多种 W）', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const W of [1, 2, 3, 4, 17, 1000]) {
      const inputs = Array.from({ length: 3000 }, () => Math.floor(rand() * 2001) - 1000);
      checkAgainstOracle(W, inputs);
    }
  });

  await test('参数校验', () => {
    assert.throws(() => new SlidingMedian(0), /INVALID_WINDOW/);
    assert.throws(() => new SlidingMedian(10001), /INVALID_WINDOW/);
    const sm = new SlidingMedian(3);
    assert.throws(() => sm.append(1.5), /INVALID_VALUE/);
    assert.throws(() => sm.append(1e9 + 1), /INVALID_VALUE/);
  });

  await test('无数据状态返回 null 而非 0/NaN', () => {
    const sm = new SlidingMedian(5);
    assert.equal(sm.currentMedian(), null);
  });

  const tmpDb = join(__dirname, '..', '..', 'data', 'test.db');

  await test('SQLite 保存与重启恢复语义一致', () => {
    rmSync(tmpDb, { force: true });
    const store = new Store(tmpDb);
    const service = new Service(store);
    const { runId } = service.createRun(4);
    const inputs = [9, 1, 8, 2, 7, 3, 6, 4, 5];
    const before = service.append(runId, null, inputs);
    store.close();
    const store2 = new Store(tmpDb);
    const service2 = new Service(store2);
    const after = service2.append(runId, null, [10, 11]);
    const sm = new SlidingMedian(4);
    const expect = [...inputs, 10, 11].map((v) => sm.append(v));
    assert.equal(after[0].median, expect[inputs.length].median);
    assert.equal(after[1].median, expect[inputs.length + 1].median);
    assert.equal(after[0].seq, inputs.length + 1);
    assert.equal(before.length, inputs.length);
    store2.close();
  });

  await test('批次幂等：相同 batchId 重试不重复计数', () => {
    rmSync(tmpDb, { force: true });
    const store = new Store(tmpDb);
    const service = new Service(store);
    const { runId } = service.createRun(3);
    const r1 = service.append(runId, 'batch-1', [1, 2, 3]);
    const r2 = service.append(runId, 'batch-1', [1, 2, 3]);
    assert.deepEqual(r2, r1);
    assert.equal(store.countSamples(runId), 3, '重试不应多算样本');
    assert.equal(service.getRun(runId).currentMedian(), 2);
    store.close();
  });

  await test('批量失败原子回滚', () => {
    rmSync(tmpDb, { force: true });
    const store = new Store(tmpDb);
    const service = new Service(store);
    const { runId } = service.createRun(3);
    service.append(runId, null, [1, 2]);
    assert.throws(() => service.append(runId, null, [3, 4, 2e9 as number]), /INVALID_VALUE/);
    assert.equal(store.countSamples(runId), 2, '失败批次应整体回滚');
    assert.equal(service.getRun(runId).currentMedian(), 1.5);
    store.close();
  });

  await test('HTTP API 端到端', async () => {
    rmSync(tmpDb, { force: true });
    const service = new Service(new Store(tmpDb));
    const server = await startServer(service, 0);
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (p: string, b: unknown) =>
      (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as any;
    const get = async (p: string) => (await fetch(base + p)).json() as any;

    const { runId } = await post('/runs', { windowSize: 3 });
    assert.ok(runId > 0);
    const append = await post(`/runs/${runId}/append`, { batchId: 'b1', values: [1, 3, -1, -3, 5, 3, 6, 7] });
    assert.equal(append.reports.length, 8);
    assert.equal(append.reports[7].median, 6);
    const med = await get(`/runs/${runId}/median`);
    assert.equal(med.median, 6);
    const hist = await get(`/runs/${runId}/history?seq=4`);
    assert.equal(hist.median, -1);
    const report = await get(`/runs/${runId}/report`);
    assert.equal(report.processedSamples, 8);
    const emptyRun = await post('/runs', { windowSize: 2 });
    const noData = await get(`/runs/${emptyRun.runId}/median`);
    assert.equal(noData.status, 'NO_DATA');
    const bad = await post('/runs', { windowSize: 0 });
    assert.equal(bad.error.code, 'INVALID_WINDOW');
    service.store.close();
    await server.close();
  });

  rmSync(tmpDb, { force: true });
  console.log(`\n全部 ${passed} 项测试通过`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
