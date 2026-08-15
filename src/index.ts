#!/usr/bin/env bun
import { PROXY_API_KEY, SERVER_HOST, SERVER_PORT } from "./core/config.ts";
import { log } from "./core/log.ts";
import { auth } from "./kiro/auth.ts";
import { handle } from "./server/route.ts";

const main = (): void => {
  // Fail fast with an actionable message rather than 500ing on the first request.
  try {
    const credential = auth.load();
    const expiry = credential.expiresAt ? new Date(credential.expiresAt).toISOString() : "unknown";
    log.info(`credential loaded (profile=${credential.profileArn ?? "none"}, token expires ${expiry})`);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!PROXY_API_KEY) log.warn("KIRO_API_KEY is unset — the server will accept unauthenticated requests");

  const server = Bun.serve({
    hostname: SERVER_HOST,
    port: SERVER_PORT,
    // Long agent turns can exceed Bun's default request timeout.
    idleTimeout: 255,
    fetch: handle,
    error(error: Error) {
      log.error(`server error: ${error.message}`);
      return new Response(
        JSON.stringify({ type: "error", error: { type: "internal_server_error", message: error.message } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  log.info(`kiro-api listening on http://${server.hostname}:${server.port}`);
};

main();
