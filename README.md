# 双堆滑动中位数与过期元素清理解释后端

定长数值窗口的在线中位数服务：连续接收整数样本，只保留最近 `W` 个样本作为有效窗口，
每次追加后报告当前中位数、窗口范围、两堆有效/物理大小、边界元素、过期清理与再平衡动作。

- 运行时：Node.js（>= 22.5，使用内置实验模块 `node:sqlite`，**无需任何原生编译或外部数据库安装**）
- 语言：TypeScript（ESM）
- 存储：SQLite（项目内 `data/median.db`）
- 交付：HTTP API + 命令行 CLI，只有后端，无 Docker / WSL / 在线服务依赖

## 核心算法与口径

- **两个堆自行实现**（`src/core/heaps.ts` 的数组二叉堆，未使用任何现成滑动中位数库，正式算法不排序整个窗口）：
  - 低半区用**最大堆**，高半区用**最小堆**；
  - 低半区有效数量等于高半区，或恰好多一；
  - 不变量：低半区边界值 `<=` 高半区边界值。
  - 平局（相同数值）按样本唯一序号 `seq` 区分比较，**相同数值的不同样本不会在过期时混淆**。
- **中位数口径**：奇数个样本取低半区堆顶；偶数个取中间两数平均，结果允许精确半整数。
  响应同时给出 `medianNumerator` / `medianDenominator`（分母为 1 或 2），整数边界 ±10 亿，和在安全整数范围内，无浮点精度损失。
- **无数据**：中位数返回 `null`（不是 0 或 NaN），`windowRange` 也为 `null`。
- **未满窗口**：按现有样本正常计算，并标记 `windowFull: false`。

### 有效长度 ≠ 物理长度

滑出窗口的样本可能埋在堆内部（不是堆顶），无法立刻摘除，因此采用**惰性删除**：

- 每个样本带唯一 `seq`，另用 `sideOfSeq` 映射记录它当前属于哪一堆；
- 过期只做**逻辑删除**（从映射中删除、有效计数减一）；
- **读取边界或移动堆顶之前**（`prune`），必须先循环弹出堆顶的已过期物理节点；
- 因此 `lowValidSize/highValidSize`（有效长度）永远以映射计数为准，
  **绝不使用堆数组的 `physicalSize`（物理长度）代替**；物理长度恒大于等于有效长度。

### 定期重建阈值（长期状态有界）

单调输入会让失效节点长期埋在堆内。规则固定为：

- 当两堆**物理节点总数 > 4 × W**（`REBUILD_FACTOR = 4`）时，
  在该次追加后用当前有效窗口样本（至多 `W` 个）排序后直接切成两半重建两堆；
- 重建记录原因与前后物理节点数（`rebuild` 字段），**不改变中位数与样本序号**；
- 重建后物理规模回到与 `W` 同量级，内存长期有界。

### 如何查看清理证据

- 每次追加报告中的 `rebalances`：
  - `{"kind":"expire",...}` = 读边界/搬运前惰性弹出的过期物理节点（含 seq/value/来源堆）；
  - `{"kind":"move","from":0,"to":1,...}` = 两堆间的再平衡搬运；
- `rebuild` 字段给出 `threshold / beforeLowPhysical / beforeHighPhysical / after*`；
- `GET /runs/:id/current` 的 `stats` 汇总 `evictedPhysicalNodes`（惰性弹出总数）与 `rebuilds` 历史。

## 持久化与一致性

SQLite 表（`src/store/db.ts`）：

- `runs`：窗口配置（窗口大小创建后**固定不可变**，改大小需新建运行）、已处理序号；
- `samples`：当前**有效窗口**样本（滑出即删除）；
- `batches`：批次幂等键 `(run_id, batch_id)`；
- `history`：每一步的中位数、两堆大小/边界、过期项、再平衡次数、是否重建。

- **批量原子提交**：先校验全部输入，再在单个 SQLite 事务中写入；任一失败整体 `ROLLBACK`，不留半批。
- **批次幂等**：带 `batchId` 的请求重试时直接返回该批已提交结果（`deduplicated: true`），不重复计算。
- **重启恢复**：仅根据 `samples` 中保存的有效窗口重建两个堆（逻辑等价于一次重建），
  语义结果与连续运行一致；已过期的物理垃圾节点不恢复。

## 参数校验与错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_WINDOW_SIZE` | W 必须是 1–10000 的整数 |
| `INVALID_VALUE` | 样本必须是 ±1,000,000,000 以内的整数 |
| `INVALID_BATCH` | 批次为空/超长（上限 50000）/ 请求体非法或过大 |
| `EMPTY_INPUT` | 未提供任何样本 |
| `BATCH_CONFLICT` | 批次事务提交冲突（已回滚） |
| `RUN_NOT_FOUND` / `SEQ_NOT_FOUND` | 运行或历史序号不存在 |

错误响应统一为 `{"error":"CODE","message":"..."}`，4xx/5xx 状态码。

## 构建、测试、启动、演示

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # 构建 + node --test（17 个用例）
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo      # 直接运行引擎演示序列并打印每步解释
```

环境变量：

- `PORT`：指定端口；不设置时自动向系统申请一个空闲端口并打印监听地址；
- `MEDIAN_DATA_DIR`：数据目录，默认 `./data`（SQLite 文件为其中的 `median.db`）。

### CLI

```powershell
node dist/cli/index.js create 3
node dist/cli/index.js append 1 1
node dist/cli/index.js append-batch 1 "1,3,-1,-3,5,3,6,7" my-batch-id
node dist/cli/index.js current 1
node dist/cli/index.js history 1 6
node dist/cli/index.js list 1 20
node dist/cli/index.js export 1
node dist/cli/index.js demo 3 "1,3,-1,-3,5,3,6,7"   # 纯引擎，不落库
```

### HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/runs` | `{"windowSize":3}` 创建运行 |
| POST | `/runs/:id/append` | `{"value":42}` 单笔追加 |
| POST | `/runs/:id/append-batch` | `{"values":[...],"batchId":"可选幂等键"}` 原子批量追加 |
| GET | `/runs/:id/current` | 当前中位数 + 两堆统计 |
| GET | `/runs/:id/history/:seq` | 按序号查历史 |
| GET | `/runs/:id/history?limit=&beforeSeq=` | 历史分页（倒序） |
| GET | `/runs/:id/export` | 导出完整报告（配置 + 全部历史 + 最终有效窗口/堆统计） |

```powershell
# 示例（PowerShell）
$run = Invoke-RestMethod -Method Post http://127.0.0.1:<port>/runs -ContentType application/json -Body '{"windowSize":3}'
Invoke-RestMethod -Method Post "http://127.0.0.1:<port>/runs/$($run.runId)/append-batch" `
  -ContentType application/json -Body '{"values":[1,3,-1,-3,5,3,6,7]}'
```

## 演示结果

W=3 输入 `1,3,-1,-3,5,3,6,7`，满窗口后中位数依次为：

| 满窗口 | 中位数 |
| --- | --- |
| [1,3,-1] | 1 |
| [3,-1,-3] | -1 |
| [-1,-3,5] | -1 |
| [-3,5,3] | 3 |
| [5,3,6] | 5 |
| [3,6,7] | 6 |

`npm run demo` 另含 W=4 偶数窗口（半整数）、大量重复值、以及 1..200 单调长序列；
后者在 W=10 时物理节点每累积到超过 40 就重建一次（如 41 → 10），可在输出中看到 `★重建` 标记。

## 测试

`src/test/engine.test.ts` 用独立的「切片排序基准」逐步对拍，覆盖：
W=1、W=3 指定序列、偶数窗口半整数、±10 亿边界、大量相同值、随机序列（多个 W）、
过期元素埋在堆内（单调递增 + 定期重建）、过期元素恰在堆顶（惰性弹出）、空窗/未满窗、参数校验；
并核对每步有效数不超过 W、两堆大小与边界不变量。

`src/test/persistence.test.ts` 覆盖原子回滚、`batchId` 幂等重试、重启恢复一致性、
历史查询与导出、错误码，以及一次可重建的长序列（W=10，200 个样本）真实处理结果。

## 已知限制（合理假设）

- 单进程本地后端，未做并发写锁以外的多实例协调；SQLite 已开启 WAL。
- 单批最多 50000 个样本、HTTP 请求体上限 5 MB（可在 `src/server.ts` 调整）。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，不影响功能。
- 幂等重试返回的是持久化的每步摘要（含中位数/边界/物理长度）；首次调用返回完整实时解释对象。
