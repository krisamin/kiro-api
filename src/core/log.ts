import { LOG_LEVEL } from "./config.ts";

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[LOG_LEVEL] ?? 20;

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19);

const emit = (level: string, args: unknown[]): void => {
  if ((LEVELS[level] ?? 20) < threshold) return;
  console.log(`${stamp()} | ${level.toUpperCase().padEnd(5)} |`, ...args);
};

export const log = {
  debug: (...args: unknown[]): void => emit("debug", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
};
