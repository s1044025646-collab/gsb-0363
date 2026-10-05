import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "./core/errors.js";
import { MedianService } from "./service.js";
import { MedianStore } from "./store/db.js";

const DATA_DIR = process.env.MEDIAN_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "median.db");

interface RouteResult {
  status: number;
  body: unknown;
}

function readJson(req: IncomingMessage, maxBytes = 5_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new AppError("INVALID_BATCH", `请求体超过 ${maxBytes} 字节限制`, 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("INVALID_BATCH", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(service: MedianService): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    try {
      let result: RouteResult;
      if (method === "GET" && path === "/health") {
        result = { status: 200, body: { ok: true, service: "dual-heap-median" } };
      } else if (method === "POST" && path === "/runs") {
        const body = (await readJson(req)) as { windowSize?: number };
        result = { status: 201, body: service.createRun(body.windowSize as number) };
      } else if (method === "POST" && /^\/runs\/\d+\/append$/.test(path)) {
        const runId = Number(path.split("/")[2]);
        const body = (await readJson(req)) as { value?: number };
        result = { status: 200, body: service.append(runId, body.value as number) };
      } else if (method === "POST" && /^\/runs\/\d+\/append-batch$/.test(path)) {
        const runId = Number(path.split("/")[2]);
        const body = (await readJson(req)) as {
          values?: number[];
          batchId?: string | null;
        };
        result = { status: 200, body: service.appendBatch(runId, body.values ?? [], body.batchId ?? null) };
      } else if (method === "GET" && /^\/runs\/\d+\/current$/.test(path)) {
        const runId = Number(path.split("/")[2]);
        result = { status: 200, body: service.current(runId) };
      } else if (method === "GET" && /^\/runs\/\d+\/history$/.test(path)) {
        const runId = Number(path.split("/")[2]);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const before = url.searchParams.get("beforeSeq");
        result = {
          status: 200,
          body: service.recentHistory(runId, limit, before ? Number(before) : undefined),
        };
      } else if (method === "GET" && /^\/runs\/\d+\/history\/\d+$/.test(path)) {
        const parts = path.split("/");
        result = { status: 200, body: service.history(Number(parts[2]), Number(parts[4])) };
      } else if (method === "GET" && /^\/runs\/\d+\/export$/.test(path)) {
        const runId = Number(path.split("/")[2]);
        result = { status: 200, body: service.exportReport(runId) };
      } else {
        throw new AppError("RUN_NOT_FOUND", `未知路由: ${method} ${path}`, 404);
      }
      send(result.status, result.body);
    } catch (err) {
      if (err instanceof AppError) {
        send(err.status, { error: err.code, message: err.message });
      } else {
        send(500, { error: "INTERNAL_ERROR", message: String(err) });
      }
    }
  });
}

/** 请求一个空闲端口：先监听 0 取得系统分配端口，再返回给调用方重新监听。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      probe.close(() =>
        addr && typeof addr !== "string"
          ? resolve((addr as AddressInfo).port)
          : reject(new Error("无法取得端口")),
      );
    });
    probe.on("error", reject);
  });
}

async function main(): Promise<void> {
  const store = new MedianStore(DB_PATH);
  const service = new MedianService(store);
  const server = createApp(service);
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  const port = requested > 0 ? requested : await pickFreePort();
  server.listen(port, "127.0.0.1", () => {
    console.log(`[median] 数据目录: ${DATA_DIR}`);
    console.log(`[median] 服务已启动: http://127.0.0.1:${port}`);
    console.log("[median] 健康检查: GET /health");
  });

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
