import { join } from 'node:path';
import { Store } from './store';
import { Service, startServer } from './server';
import { SlidingMedian } from './median';

const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'median.db');

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'serve';

  if (cmd === 'serve') {
    const portArg = argValue(args, '--port');
    const port = portArg !== null ? Number(portArg) : 0; // 默认选择空闲端口
    const service = new Service(new Store(DB_PATH));
    const server = await startServer(service, port);
    console.log(`滑动中位数服务已启动: http://127.0.0.1:${server.port}  数据目录: ${DATA_DIR}`);
    return;
  }

  if (cmd === 'demo') {
    runDemo();
    return;
  }

  console.error('用法: node dist/cli.js serve [--port N] | demo');
  process.exit(1);
}

function runDemo() {
  console.log('=== 演示 1: W=3, 输入 1,3,-1,-3,5,3,6,7 ===');
  const sm = new SlidingMedian(3);
  for (const v of [1, 3, -1, -3, 5, 3, 6, 7]) {
    const r = sm.append(v);
    console.log(
      `seq=${r.seq} 值=${r.value} 窗口=[${r.windowLo}..${r.windowHi}] ` +
      `${r.windowFull ? '满' : '未满'} 中位数=${r.median} ` +
      `lo有效=${r.loValid} hi有效=${r.hiValid} 边界=[${r.loBoundary}, ${r.hiBoundary}]` +
      (r.evictedSeq ? ` 过期seq=${r.evictedSeq}(值${r.evictedValue})` : '') +
      (r.rebalances.length ? ` 再平衡=${r.rebalances.map((x) => x.direction).join(',')}` : '')
    );
  }

  console.log('\n=== 演示 2: 偶数窗口 W=4, 输入 2,1,4,3（半整数中位数）===');
  const sm2 = new SlidingMedian(4);
  for (const v of [2, 1, 4, 3]) {
    const r = sm2.append(v);
    console.log(`seq=${r.seq} 值=${v} 中位数=${r.median} 满=${r.windowFull}`);
  }

  console.log('\n=== 演示 3: 重复值 W=3, 输入 5,5,5,5,5 ===');
  const sm3 = new SlidingMedian(3);
  for (const v of [5, 5, 5, 5, 5]) {
    const r = sm3.append(v);
    console.log(`seq=${r.seq} 中位数=${r.median} lo有效=${r.loValid} hi有效=${r.hiValid} lo物理=${r.loPhysical} hi物理=${r.hiPhysical}`);
  }

  console.log('\n=== 演示 4: 单调长序列 W=100, 输入 1..100000（观察惰性垃圾与重建）===');
  const sm4 = new SlidingMedian(100);
  let lastRebuilds = 0;
  for (let v = 1; v <= 100000; v++) {
    const r = sm4.append(v);
    if (r.rebuild) {
      lastRebuilds++;
      if (lastRebuilds <= 5) {
        console.log(`seq=${r.seq} 重建: ${r.rebuild.reason}; 节点 ${r.rebuild.beforeNodes} -> ${r.rebuild.afterNodes}`);
      }
    }
  }
  const snap = sm4.snapshot();
  console.log(
    `处理 100000 个样本, 最终中位数=${snap.median}, 有效=${snap.validCount}, ` +
    `物理节点=${snap.loPhysical + snap.hiPhysical}, 重建次数=${lastRebuilds}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
