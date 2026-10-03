import { createHash } from "node:crypto";
import type { KiroHistoryEntry, KiroPayload } from "./type.ts";

/**
 * Kiro's prompt cache, as far as this proxy can see it.
 *
 * ★Kiro caches but never says so. Its metadataEvent carries only `stopReason`;
 * the `tokenUsage` the service model defines (uncached, cache read, cache
 * write) stays empty - the official kiro-cli 2.18.1 gets the same bare event
 * (trace log, 2026-10-03). So every call was reported as a fully fresh prompt,
 * and ara's ledger showed 1.5 billion Opus 5.5 tokens with no cache read.
 *
 * The cache is real all the same. Measured by credits with claude-opus-5.5 on
 * a 39k-token prompt (2026-10-03): the first call cost 12.29 credits per
 * million prompt tokens, a repeat 3.35, and an agent-loop growth of one turn
 * per call 4.4-4.6 - each call read what the previous call's history had
 * written. A client `cachePoint` changed nothing; the service places its own.
 *
 * So the split is worked out here the way the service behaves: a call writes
 * its history (everything before the current message) and a later call reads
 * the longest history prefix written within the TTL, looking back up to
 * LOOKBACK entries. The token figures are proportions of the measured prompt,
 * so they add up to exactly what was reported before - only the split is new,
 * and it is an estimate like every Kiro token count.
 */

/** Anthropic's default cache lifetime, renewed on every read. */
export const CACHE_TTL_MS = 5 * 60_000;

/** How many history entries back a read is looked for (Anthropic's block lookback). */
const LOOKBACK = 20;

/** Bound on remembered prefixes; the oldest go first. */
const MAX_REMEMBERED = 4096;

/** An image is about 1,600 tokens; count it as that many characters' worth. */
const IMAGE_CHARS = 1600 * 4;

export type CacheSplit = { read: number; write: number; fresh: number };

export type CachePlan = {
  /** Prefix hash after each history entry. */
  hashList: string[];
  /** Characters up to and including each history entry, counted from the start. */
  sizeList: number[];
  /** Characters of the whole request. */
  total: number;
};

const remembered = new Map<string, number>();

const digest = (previous: string, part: string): string =>
  createHash("sha256").update(previous).update("\u0000").update(part).digest("hex");

/** Characters an entry weighs, with image bytes replaced by their token worth. */
const sizeOf = (value: unknown): number => {
  let imageCount = 0;
  const text = JSON.stringify(value, (key, inner) => {
    if (key === "bytes" && typeof inner === "string") {
      imageCount++;
      return "";
    }
    return inner;
  });
  return (text?.length ?? 0) + imageCount * IMAGE_CHARS;
};

/**
 * The prefixes of a payload as the service would cache them.
 *
 * The seed holds what sits in front of the conversation and invalidates all
 * of it when it changes: the model, the tool list (Kiro carries it on the
 * current message, the model sees it first) and the request fields.
 */
export const planOf = (payload: KiroPayload): CachePlan => {
  // Optional all the way down: this runs after the answer has been streamed,
  // and a malformed payload must cost the split, not the response.
  const current = payload?.conversationState?.currentMessage?.userInputMessage;
  const tools = current?.userInputMessageContext?.tools ?? [];
  const head = JSON.stringify([current?.modelId ?? "", tools, payload?.additionalModelRequestFields ?? null]);
  let hash = digest("kiro-cache", head);
  let size = sizeOf(tools);
  const hashList: string[] = [];
  const sizeList: number[] = [];
  for (const entry of (payload?.conversationState?.history ?? []) as KiroHistoryEntry[]) {
    hash = digest(hash, JSON.stringify(entry));
    size += sizeOf(entry);
    hashList.push(hash);
    sizeList.push(size);
  }
  const { userInputMessageContext, ...rest } = current ?? {};
  const currentSize = sizeOf({ ...rest, toolResults: userInputMessageContext?.toolResults ?? [] });
  return { hashList, sizeList, total: size + currentSize };
};

const alive = (hash: string, now: number): boolean => {
  const expiresAt = remembered.get(hash);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  remembered.delete(hash);
  return false;
};

const remember = (hash: string, now: number): void => {
  remembered.delete(hash);
  remembered.set(hash, now + CACHE_TTL_MS);
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
};

/**
 * Split a measured prompt into read, write and fresh, and record what this
 * call wrote. Call it once, after the call has completed: a call that failed
 * wrote nothing.
 */
export const settleCache = (plan: CachePlan, promptToken: number, now = Date.now()): CacheSplit => {
  const last = plan.hashList.length - 1;
  let readSize = 0;
  for (let index = last; index >= 0 && index >= last - LOOKBACK; index--) {
    const hash = plan.hashList[index] as string;
    if (alive(hash, now)) {
      readSize = plan.sizeList[index] as number;
      remember(hash, now);
      break;
    }
  }
  const historySize = last >= 0 ? (plan.sizeList[last] as number) : 0;
  if (last >= 0) remember(plan.hashList[last] as string, now);

  const total = Math.max(plan.total, 1);
  const prompt = Math.max(0, promptToken);
  const read = Math.min(prompt, Math.round((prompt * readSize) / total));
  const write = Math.min(prompt - read, Math.round((prompt * Math.max(0, historySize - readSize)) / total));
  return { read, write, fresh: prompt - read - write };
};

/** Forget every remembered prefix (tests). */
export const resetCache = (): void => remembered.clear();
