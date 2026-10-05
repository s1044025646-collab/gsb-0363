import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { SlidingMedian } from './median';
import { Store } from './store';

export class Service {
  private runs = new Map<number, SlidingMedian>();
  constructor(public readonly store: Store) {}

  createRun(windowSize: number): { runId: number } {
    const sm = new SlidingMedian(windowSize); // 校验窗口
    const runId = this.store.createRun(windowSize);
    this.runs.set(runId, sm);
    return { runId };
  }

  /** 获取运行实例；进程重启后从 SQLite 有效窗口重建堆 */
  getRun(runId: number): SlidingMedian {
    let sm = this.runs.get(runId);
    if (!sm) {
      const run = this.store.getRun(runId);
      if (!run) throw new Error('RUN_NOT_FOUND: 运行不存在');
      sm = SlidingMedian.restore(run.window_size, this.store.loadWindowSamples(runId));
      this.runs.set(runId, sm);
    }
    return sm;
  }

  append(runId: number, batchId: string | null, values: number[]) {
    if (values.length === 0) throw new Error('EMPTY_BATCH: 批量输入不能为空');
    for (const v of values) {
      if (!Number.isInteger(v) || v < -1e9 || v > 1e9) {
        throw new Error('INVALID_VALUE: value 必须是 [-1e9, 1e9] 内的整数');
      }
    }
    const sm = this.getRun(runId);
    return this.store.appendBatch(runId, batchId, values, (v) => sm.append(v));
  }
}

function err(code: string, message: string) {
  return { error: { code, message } };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('BAD_JSON: 请求体不是合法 JSON');
  }
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

export function startServer(service: Service, port: number): Promise<RunningServer> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(s);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const body = req.method === 'POST' ? await readBody(req) : {};

      if (req.method === 'POST' && url.pathname === '/runs') {
        return send(201, service.createRun(body.windowSize));
      }
      const m = parts[0] === 'runs' ? Number(parts[1]) : NaN;
      if (!Number.isInteger(m)) return send(404, err('NOT_FOUND', '路径不存在'));
      const sub = parts[2];

      if (req.method === 'POST' && sub === 'append') {
        const values: number[] = Array.isArray(body.values) ? body.values : [body.value];
        const batchId = typeof body.batchId === 'string' ? body.batchId : null;
        return send(200, { reports: service.append(m, batchId, values) });
      }
      if (req.method === 'GET' && sub === 'median') {
        const sm = service.getRun(m);
        const median = sm.currentMedian();
        if (median === null) return send(200, { status: 'NO_DATA', median: null });
        return send(200, { status: 'OK', median, snapshot: sm.snapshot() });
      }
      if (req.method === 'GET' && sub === 'state') {
        return send(200, service.getRun(m).snapshot());
      }
      if (req.method === 'GET' && sub === 'history') {
        const seq = url.searchParams.get('seq');
        if (seq !== null) {
          const r = service.store.getResult(m, Number(seq));
          return r ? send(200, r) : send(404, err('SEQ_NOT_FOUND', '该序号无历史结果'));
        }
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return send(200, { reports: service.store.listResults(m, limit, offset) });
      }
      if (req.method === 'GET' && sub === 'report') {
        const run = service.store.getRun(m);
        if (!run) return send(404, err('RUN_NOT_FOUND', '运行不存在'));
        return send(200, {
          runId: m,
          windowSize: run.window_size,
          processedSamples: service.store.countSamples(m),
          snapshot: service.getRun(m).snapshot(),
          rebuilds: service.store.listRebuilds(m),
        });
      }
      return send(404, err('NOT_FOUND', '路径不存在'));
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      const code = msg.includes(':') ? msg.split(':')[0] : 'INTERNAL';
      const status = code === 'RUN_NOT_FOUND' ? 404 : code === 'INTERNAL' ? 500 : 400;
      send(status, err(code, msg));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}
