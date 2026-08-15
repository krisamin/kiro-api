import { Database } from "bun:sqlite";
import {
  API_REGION,
  apiHost,
  desktopRefreshUrl,
  KIRO_CLI_DB,
  ssoOidcUrl,
  TOKEN_REFRESH_SKEW_SEC,
} from "../core/config.ts";
import { log } from "../core/log.ts";

/**
 * Reads credentials written by `kiro-cli login` and keeps the access token fresh.
 *
 * kiro-cli stores everything in a SQLite file:
 *   auth_kv['kirocli:odic:token']               access/refresh token + expiry
 *   auth_kv['kirocli:odic:device-registration'] OIDC client id/secret
 *   state['api.codewhisperer.profile']          profile ARN (Identity Center only)
 *
 * Two refresh flows exist depending on how the user logged in:
 *   - Identity Center (`--license pro`): AWS SSO OIDC CreateToken, needs the
 *     device registration's client_id/client_secret.
 *   - Builder ID (`--license free`): Kiro's own desktop refresh endpoint.
 */

type TokenRecord = {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresAt?: string;
  expires_at?: string;
  region?: string;
  startUrl?: string;
  start_url?: string;
};

type DeviceRegistration = {
  clientId?: string;
  client_id?: string;
  clientSecret?: string;
  client_secret?: string;
  region?: string;
};

const pick = (...values: Array<string | undefined>): string | undefined =>
  values.find((v) => v !== undefined && v !== "");

const readJsonRow = (db: Database, sql: string, key: string): Record<string, unknown> | undefined => {
  const row = db.query(sql).get(key) as { value?: string } | null;
  if (!row?.value) return undefined;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export type Credential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  profileArn?: string;
  ssoRegion: string;
  clientId?: string;
  clientSecret?: string;
};

export class KiroAuth {
  private credential: Credential | undefined;
  private refreshing: Promise<void> | undefined;

  readonly apiHost: string = apiHost(API_REGION);

  /** Load the current credential snapshot from the kiro-cli database. */
  load(): Credential {
    const db = new Database(KIRO_CLI_DB, { readonly: true });
    try {
      const token = readJsonRow(db, "SELECT value FROM auth_kv WHERE key = ?", "kirocli:odic:token") as
        | TokenRecord
        | undefined;
      if (!token) {
        throw new Error(`No Kiro token in ${KIRO_CLI_DB}. Run: kiro-cli login`);
      }

      const registration = readJsonRow(
        db,
        "SELECT value FROM auth_kv WHERE key = ?",
        "kirocli:odic:device-registration",
      ) as DeviceRegistration | undefined;

      const profile = readJsonRow(db, "SELECT value FROM state WHERE key = ?", "api.codewhisperer.profile");
      const profileArn = typeof profile?.arn === "string" ? profile.arn : undefined;

      const accessToken = pick(token.accessToken, token.access_token);
      const refreshToken = pick(token.refreshToken, token.refresh_token);
      if (!accessToken || !refreshToken) throw new Error("Kiro token record is missing access/refresh token");

      const expiresRaw = pick(token.expiresAt, token.expires_at);
      const expiresAt = expiresRaw ? Date.parse(expiresRaw) : 0;

      return {
        accessToken,
        refreshToken,
        expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt,
        profileArn,
        ssoRegion: pick(token.region, registration?.region) ?? API_REGION,
        clientId: pick(registration?.clientId, registration?.client_id),
        clientSecret: pick(registration?.clientSecret, registration?.client_secret),
      };
    } finally {
      db.close();
    }
  }

  private get current(): Credential {
    if (!this.credential) this.credential = this.load();
    return this.credential;
  }

  get profileArn(): string | undefined {
    return this.current.profileArn;
  }

  /** Access token, refreshed if it is expired or about to expire. */
  async token(): Promise<string> {
    const cred = this.current;
    const stillValid = cred.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_SEC * 1000;
    if (stillValid) return cred.accessToken;

    // Another request may already be refreshing; share that work.
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    await this.refreshing;
    return this.current.accessToken;
  }

  /**
   * Force a refresh regardless of the cached expiry.
   *
   * Used when Kiro rejects a token the clock still considered valid — clock
   * skew or a server-side revocation both look like this.
   */
  async forceRefresh(): Promise<string> {
    if (this.credential) this.credential = { ...this.credential, expiresAt: 0 };
    if (!this.refreshing) {
      this.refreshing = this.refresh(true).finally(() => {
        this.refreshing = undefined;
      });
    }
    await this.refreshing;
    return this.current.accessToken;
  }

  /**
   * Refresh the access token.
   *
   * kiro-cli itself refreshes into the same SQLite file, so we re-read first:
   * if the CLI (or another kiro-api process) already refreshed, we adopt that
   * token instead of burning a second refresh and racing over the same grant.
   */
  private async refresh(force = false): Promise<void> {
    const reloaded = this.load();
    if (!force && reloaded.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_SEC * 1000) {
      log.info("token refreshed by another process; adopting it");
      this.credential = reloaded;
      return;
    }

    const cred = reloaded;
    const useSsoOidc = Boolean(cred.clientId && cred.clientSecret);
    log.info(`refreshing access token via ${useSsoOidc ? "AWS SSO OIDC" : "Kiro desktop auth"}`);

    const { accessToken, refreshToken, expiresIn } = useSsoOidc
      ? await this.refreshViaSsoOidc(cred)
      : await this.refreshViaDesktop(cred);

    this.credential = {
      ...cred,
      accessToken,
      refreshToken: refreshToken || cred.refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    log.info(`token refreshed, valid for ${Math.round(expiresIn / 60)} min`);
  }

  private async refreshViaSsoOidc(
    cred: Credential,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await fetch(ssoOidcUrl(cred.ssoRegion), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cred.clientId ?? "",
        client_secret: cred.clientSecret ?? "",
        refresh_token: cred.refreshToken,
      }),
    });
    if (!res.ok) {
      throw new Error(`SSO OIDC refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      accessToken?: string;
      access_token?: string;
      refreshToken?: string;
      refresh_token?: string;
      expiresIn?: number;
      expires_in?: number;
    };
    const accessToken = pick(body.accessToken, body.access_token);
    if (!accessToken) throw new Error("SSO OIDC refresh returned no access token");
    return {
      accessToken,
      refreshToken: pick(body.refreshToken, body.refresh_token) ?? cred.refreshToken,
      expiresIn: body.expiresIn ?? body.expires_in ?? 3600,
    };
  }

  private async refreshViaDesktop(
    cred: Credential,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const res = await fetch(desktopRefreshUrl(cred.ssoRegion), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: cred.refreshToken }),
    });
    if (!res.ok) {
      throw new Error(`Kiro desktop refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
    if (!body.accessToken) throw new Error("Kiro desktop refresh returned no access token");
    return {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken ?? cred.refreshToken,
      expiresIn: body.expiresIn ?? 3600,
    };
  }
}

export const auth = new KiroAuth();
