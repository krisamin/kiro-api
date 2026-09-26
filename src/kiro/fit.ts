import { CONTEXT_WINDOW, MAX_REFIT, REFIT_RATIO } from "../core/config.ts";
import { log } from "../core/log.ts";
import { invoke, KiroApiError } from "./client.ts";
import { shrinkPayload } from "./payload.ts";
import type { KiroEvent, KiroPayload } from "./type.ts";

/** Kiro's wording for a prompt that does not fit the window. */
export const overflowed = (error: unknown): boolean =>
  error instanceof KiroApiError && error.status === 400 && /exceeds threshold/i.test(error.message);

/**
 * The refusal as an Anthropic client expects to read it.
 *
 * Clients recognise an over-window prompt by its text (ara matches
 * `prompt is too long`), and Kiro's own sentence says nothing they look for.
 * No token count is given because Kiro does not report one for a refused
 * request, and a guessed figure would be taken as a measurement.
 */
export const overflowMessage = (error: KiroApiError): string =>
  `prompt is too long: over the ${CONTEXT_WINDOW} token context window (Kiro: ${error.message})`;

/**
 * `invoke`, shrinking the history and asking again when the window is full.
 *
 * The client is expected to keep itself inside the window - the usage reported
 * back is the service's own count, so it can. This is the net under that: a
 * refusal arrives as the response status before a single event, so nothing has
 * been passed on yet and sending a smaller payload is invisible to the caller.
 * Once any event has gone out the error is passed through untouched.
 *
 * Only the oldest turns go, and the system prompt is put back on whatever is
 * earliest afterwards (payload.ts).
 */
export async function* invokeFitted(payload: KiroPayload, signal?: AbortSignal): AsyncGenerator<KiroEvent> {
  for (let attempt = 0; ; attempt++) {
    let yielded = false;
    try {
      for await (const event of invoke(payload, signal)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      if (yielded || !overflowed(error) || attempt >= MAX_REFIT || signal?.aborted) throw error;
      if (!shrinkPayload(payload, REFIT_RATIO)) throw error;
      log.warn(`over the context window; refit ${attempt + 1}/${MAX_REFIT} kept ${REFIT_RATIO * 100}% and retrying`);
    }
  }
}

/** The service's own prompt count, from its context-usage percentage. */
export const measuredPromptToken = (percent: number): number | undefined =>
  percent > 0 ? Math.round((percent / 100) * CONTEXT_WINDOW) : undefined;
