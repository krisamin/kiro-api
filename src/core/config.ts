import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Runtime configuration.
 *
 * Secrets (the proxy API key) come from the environment; everything else is
 * behavioural config with sane defaults.
 */

const env = (key: string, fallback: string): string => Bun.env[key] ?? fallback;

const expandHome = (path: string): string => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

/** Bearer token clients must present. Empty string disables auth (local-only use). */
export const PROXY_API_KEY: string = Bun.env.KIRO_API_KEY ?? "";

export const SERVER_HOST: string = env("KIRO_API_HOST", "127.0.0.1");
export const SERVER_PORT: number = Number(env("KIRO_API_PORT", "9101"));

/** kiro-cli credential store. Written by `kiro-cli login`. */
export const KIRO_CLI_DB: string = expandHome(env("KIRO_CLI_DB", "~/.local/share/kiro-cli/data.sqlite3"));

/** Region used for the inference endpoint (separate from the SSO region). */
export const API_REGION: string = env("KIRO_API_REGION", "us-east-1");

export const apiHost = (region: string): string => `https://runtime.${region}.kiro.dev`;
export const ssoOidcUrl = (region: string): string => `https://oidc.${region}.amazonaws.com/token`;
export const desktopRefreshUrl = (region: string): string =>
  `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`;

/**
 * The model's context window, in tokens.
 *
 * ★This is the real limit, and it is 1M. Kiro's `Input content length exceeds
 * threshold.` is the window being full, not a byte ceiling. Measured
 * 2026-09-27 against the service directly (no trimming in between):
 *
 * - `contextUsageEvent.contextUsagePercentage` is the prompt over exactly
 *   1,000,000 tokens. The same text counted by Anthropic's count_tokens grew
 *   by 125,001 tokens between 500KB and 1MB, and the percentage grew by
 *   12.500 points over the same step.
 * - The 400 lands exactly where that percentage would pass 100: 99.36%
 *   answered, the next step up (about 100.6%) was refused.
 * - Bytes do not decide it. Real TypeScript went through at 2.55MB (96%, and a
 *   needle 5% from the front was found), while a token-dense filler was
 *   refused at 2.07MB.
 *
 * The old reading ("a 2.38MB byte wall") came from bisecting one filler and
 * converting it with a 4-characters-per-token guess, which made a full window
 * look like 560K tokens.
 */
export const CONTEXT_WINDOW: number = Number(env("KIRO_CONTEXT_WINDOW", "1000000"));

/**
 * A last-resort size cap, applied before sending.
 *
 * Not the limit that matters: the window is counted in tokens (see
 * CONTEXT_WINDOW) and anything over it is refused and refitted after the fact
 * (kiro/fit.ts). This only stops a request so large that no token density
 * could fit it from being sent at all - 1M tokens is under 5MB of any real
 * text, images aside.
 */
export const MAX_PAYLOAD_BYTES: number = Number(env("KIRO_MAX_PAYLOAD_BYTES", "12000000"));

/** How many times an over-window request is shrunk and sent again. */
export const MAX_REFIT: number = Number(env("KIRO_MAX_REFIT", "5"));

/** What each refit keeps of the payload's bytes. */
export const REFIT_RATIO = 0.85;

/** Kiro rejects tool descriptions past this length; longer ones move to the system prompt. */
export const MAX_TOOL_DESCRIPTION: number = Number(env("KIRO_MAX_TOOL_DESCRIPTION", "10000"));

/** Kiro rejects tool names longer than this. */
export const MAX_TOOL_NAME = 64;

/** Refresh the access token this many seconds before it actually expires. */
export const TOKEN_REFRESH_SKEW_SEC = 120;

/**
 * How often to send an SSE `ping` while waiting on Kiro.
 *
 * Kiro can take a long time to produce its first event on a large
 * conversation - measured up to 43s before the first byte, and the model
 * thinking before a tool call is the usual reason. Anything in between the
 * client and here that watches for silence will call that a dead connection:
 * ara's device relay drops a request after 30s of no events, which is exactly
 * the failure this prevents. A ping is part of the Messages API's own event
 * set, so a client that does not care can ignore it.
 */
export const PING_INTERVAL_MS: number = Number(env("KIRO_PING_INTERVAL_MS", "10000"));

export const LOG_LEVEL: string = env("KIRO_LOG_LEVEL", "info");
