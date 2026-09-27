import { writeFileSync } from "node:fs";
import { log } from "../core/log.ts";
import type { MetadataEvent } from "./type.ts";

/** The refusal a metadata event carries, as one readable line. */
export const refusalOf = (data: MetadataEvent): string | undefined => {
  const refusal = data.stopDetails?.refusal;
  if (!refusal) return undefined;
  return `Kiro refused this request (${refusal.category ?? "unknown"}): ${refusal.explanation ?? "no explanation"}`;
};

/**
 * Keep the request that came back empty, so the next one can be replayed.
 * Only the last one is kept; it holds the conversation, so it stays local.
 */
export const dumpEmpty = (body: unknown, why: string): void => {
  const path = `${process.env.HOME}/.local/state/kiro-api-last-empty.json`;
  try {
    writeFileSync(path, JSON.stringify({ why, at: new Date().toISOString(), body }), { mode: 0o600 });
    log.warn(`empty answer (${why}); request kept at ${path}`);
  } catch (error) {
    log.warn(`empty answer (${why}); could not keep the request: ${String(error)}`);
  }
};
