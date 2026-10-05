#!/usr/bin/env node
import { join } from "node:path";
import { AppError } from "../core/errors.js";
import { MedianWindow } from "../core/engine.js";
import { MedianService } from "../service.js";
import { MedianStore } from "../store/db.js";

const DATA_DIR = process.env.MEDIAN_DATA_DIR ?? join(process.cwd(), "data");
const store = new MedianStore(join(DATA_DIR, "median.db"));
const service = new MedianService(store);

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function usage(): never {
  console.error(`用法:
  median-cli create <W>                       创建窗口大小为 W 的运行
  median-cli append <runId> <value>           追加单个样本
  median-cli append-batch <runId> <v1,v2,..> [batchId]  批量追加（原子提交，batchId 用于幂等重试）
  median-cli current <runId>                  查看当前中位数与堆状态
  median-cli history <runId> <seq>            按序号查历史
  median-cli list <runId> [limit]             列出最近历史
  median-cli export <runId>                   导出完整报告
  median-cli demo <W> <v1,v2,..>              本地直接跑序列并打印每步解释（不落库）`);
  process.exit(1);
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "create":
        print(service.createRun(Number(args[0])));
        break;
      case "append":
        print(service.append(Number(args[0]), Number(args[1])));
        break;
      case "append-batch": {
        const values = (args[1] ?? "").split(",").map((s) => Number(s.trim()));
        print(service.appendBatch(Number(args[0]), values, args[2] ?? null));
        break;
      }
      case "current":
        print(service.current(Number(args[0])));
        break;
      case "history":
        print(service.history(Number(args[0]), Number(args[1])));
        break;
      case "list":
        print(service.recentHistory(Number(args[0]), Number(args[1] ?? 20)));
        break;
      case "export":
        print(service.exportReport(Number(args[0])));
        break;
      case "demo": {
        // 纯引擎演示，不触碰数据库
        const w = new MedianWindow(Number(args[0]));
        const values = (args[1] ?? "").split(",").map((s) => Number(s.trim()));
        for (const v of values) print(w.append(v));
        print({ stats: w.getStats() });
        break;
      }
      default:
        usage();
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exit(2);
    }
    throw err;
  } finally {
    store.close();
  }
}

main();
