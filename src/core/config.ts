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
 * Kiro rejects payloads larger than roughly 615KB with a misleading
 * "Improperly formed request" error, so we trim history below a safe ceiling.
 */
export const MAX_PAYLOAD_BYTES: number = Number(env("KIRO_MAX_PAYLOAD_BYTES", "600000"));

/** Kiro rejects tool descriptions past this length; longer ones move to the system prompt. */
export const MAX_TOOL_DESCRIPTION: number = Number(env("KIRO_MAX_TOOL_DESCRIPTION", "10000"));

/** Kiro rejects tool names longer than this. */
export const MAX_TOOL_NAME = 64;

/** Refresh the access token this many seconds before it actually expires. */
export const TOKEN_REFRESH_SKEW_SEC = 120;

export const LOG_LEVEL: string = env("KIRO_LOG_LEVEL", "info");
