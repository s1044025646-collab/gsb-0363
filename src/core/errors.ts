export type ErrorCode =
  | "INVALID_WINDOW_SIZE"
  | "INVALID_VALUE"
  | "INVALID_BATCH"
  | "SEQ_CONFLICT"
  | "BATCH_CONFLICT"
  | "RUN_NOT_FOUND"
  | "SEQ_NOT_FOUND"
  | "EMPTY_INPUT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const MAX_W = 10_000;
export const MIN_W = 1;
export const MAX_ABS_VALUE = 1_000_000_000;

export function validateWindowSize(w: unknown): number {
  if (typeof w !== "number" || !Number.isInteger(w)) {
    throw new AppError("INVALID_WINDOW_SIZE", "窗口大小 W 必须是整数");
  }
  if (w < MIN_W || w > MAX_W) {
    throw new AppError(
      "INVALID_WINDOW_SIZE",
      `窗口大小 W 必须在 ${MIN_W} 到 ${MAX_W} 之间，收到 ${w}`,
    );
  }
  return w;
}

export function validateValue(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new AppError("INVALID_VALUE", `样本值必须是整数，收到 ${String(v)}`);
  }
  if (v < -MAX_ABS_VALUE || v > MAX_ABS_VALUE) {
    throw new AppError(
      "INVALID_VALUE",
      `样本值必须在 ±${MAX_ABS_VALUE} 之内，收到 ${v}`,
    );
  }
  return v;
}
