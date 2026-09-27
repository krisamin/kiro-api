import { CONTEXT_WINDOW, MAX_REFIT, REFIT_RATIO } from "../core/config.ts";
import { log } from "../core/log.ts";
import { invoke, KiroApiError } from "./client.ts";
import { dropNativeThinking, shrinkPayload, stripThinking } from "./payload.ts";
import { noNativeThinkingSet, noThinkingModelSet } from "./thinking.ts";
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
    // Events before the first word are held: a reasoning refusal arrives as
    // metadata on a stream that said nothing, and a retry is only invisible to
    // the caller while nothing has been passed on.
    const held: KiroEvent[] = [];
    let retryWithoutThinking = false;
    try {
      for await (const event of invoke(payload, signal)) {
        if (!yielded) {
          if (event.type === "metadata" && reasoningRefused(event.data) && stripThinking(payload)) {
            retryWithoutThinking = true;
            break;
          }
          if (event.type !== "assistantResponse" && event.type !== "toolUse" && event.type !== "reasoning") {
            held.push(event);
            continue;
          }
          yielded = true;
          yield* held;
        }
        yield event;
      }
      if (retryWithoutThinking) {
        const model = payload.conversationState.currentMessage.userInputMessage.modelId;
        noThinkingModelSet.add(model);
        log.warn(
          `${model} refused written reasoning (REASONING_EXTRACTION); retrying without the thinking instruction`,
        );
        attempt--;
        continue;
      }
      yield* held;
      return;
    } catch (error) {
      if (!yielded && nativeRefused(error) && dropNativeThinking(payload)) {
        const model = payload.conversationState.currentMessage.userInputMessage.modelId;
        noNativeThinkingSet.add(model);
        log.warn(`${model} does not take native thinking; falling back to the prompt instruction`);
        attempt--;
        continue;
      }
      if (yielded || !overflowed(error) || attempt >= MAX_REFIT || signal?.aborted) throw error;
      if (!shrinkPayload(payload, REFIT_RATIO)) throw error;
      log.warn(`over the context window; refit ${attempt + 1}/${MAX_REFIT} kept ${REFIT_RATIO * 100}% and retrying`);
    }
  }
}

/** A model that does not take `additionalModelRequestFields` (or its `thinking`). */
const nativeRefused = (error: unknown): boolean =>
  error instanceof KiroApiError && error.status === 400 && /additionalModelRequestFields/.test(error.message);

/** Kiro's refusal of a prompt that asks the model to write its reasoning down. */
const reasoningRefused = (data: { stopDetails?: { refusal?: { category?: string } } }): boolean =>
  data.stopDetails?.refusal?.category === "REASONING_EXTRACTION";

/** The service's own prompt count, from its context-usage percentage. */
export const measuredPromptToken = (percent: number): number | undefined =>
  percent > 0 ? Math.round((percent / 100) * CONTEXT_WINDOW) : undefined;
