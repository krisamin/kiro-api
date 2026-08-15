#!/usr/bin/env bun
import { parseToolInput, ResponseBuilder } from "./anthropic/response.ts";
import type { MessagesRequest } from "./anthropic/type.ts";
import { auth } from "./kiro/auth.ts";
import { invoke } from "./kiro/client.ts";
import { convertTools, normalizeMessages, sanitizeSchema } from "./kiro/convert.ts";
/**
 * Self-test: pure conversion/parsing logic plus a live round trip.
 *
 * Run with `bun run selftest`. Set KIRO_SELFTEST_LIVE=0 to skip the network
 * portion (the pure checks still run and are the ones that catch regressions in
 * Kiro's structural rules).
 */
import { crc32, EventStreamDecoder } from "./kiro/event-stream.ts";
import { KNOWN_MODELS, normalizeModel } from "./kiro/model.ts";
import { buildPayload } from "./kiro/payload.ts";
import type { KiroHistoryEntry } from "./kiro/type.ts";

let passed = 0;
let failed = 0;

const check = (name: string, condition: boolean, detail = ""): void => {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
};

const eq = (name: string, actual: unknown, expected: unknown): void =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

console.log("\n=== model normalisation ===");
eq("date suffix stripped", normalizeModel("claude-opus-5-20260101"), "claude-opus-5");
eq("dashed version to dots", normalizeModel("claude-opus-4-5"), "claude-opus-4.5");
eq("latest suffix stripped", normalizeModel("claude-sonnet-4.6-latest"), "claude-sonnet-4.6");
eq("already normal untouched", normalizeModel("claude-opus-5"), "claude-opus-5");
check("registry non-empty", KNOWN_MODELS.length > 0);

console.log("\n=== schema sanitisation (Kiro 400 triggers) ===");
eq("empty required dropped", sanitizeSchema({ type: "object", required: [], properties: {} }), {
  type: "object",
  properties: {},
});
eq(
  "additionalProperties dropped at depth",
  sanitizeSchema({ type: "object", properties: { a: { type: "string", additionalProperties: false } } }),
  { type: "object", properties: { a: { type: "string" } } },
);
eq("populated required kept", sanitizeSchema({ required: ["x"] }), { required: ["x"] });

console.log("\n=== tool conversion ===");
const longDesc = "x".repeat(20000);
const converted = convertTools([{ name: "big", description: longDesc, input_schema: { type: "object" } }]);
check("long description moved to system prompt", converted.documentation.includes("## Tool: big"));
check("long description replaced inline", (converted.tools[0]?.toolSpecification.description.length ?? 0) < 200);
check(
  "empty description gets placeholder",
  convertTools([{ name: "t", input_schema: {} }]).tools[0]?.toolSpecification.description === "Tool: t",
);
let threwOnLongName = false;
try {
  convertTools([{ name: "n".repeat(65), description: "d" }]);
} catch {
  threwOnLongName = true;
}
check("over-long tool name rejected", threwOnLongName);

console.log("\n=== message normalisation (Kiro structural rules) ===");
const alternated = normalizeMessages(
  [
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
  ],
  false,
);
eq(
  "adjacent same-role merged",
  alternated.map((m) => m.role),
  ["user", "assistant"],
);
eq("merged text joined", alternated[0]?.text, "a\nb");

const leadingAssistant = normalizeMessages(
  [
    { role: "assistant", content: "ignored" },
    { role: "user", content: "real" },
  ],
  false,
);
eq("history starts with user", leadingAssistant[0]?.role, "user");

const unknownRole = normalizeMessages([{ role: "developer", content: "hi" }], false);
eq("unknown role becomes user", unknownRole[0]?.role, "user");

const strippedTools = normalizeMessages(
  [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
  ],
  false,
);
check(
  "tool traffic folded to text when no tools declared",
  strippedTools.every((m) => m.toolUses.length === 0),
);
check("tool call text preserved", JSON.stringify(strippedTools).includes("tool call: f"));

console.log("\n=== payload assembly ===");
const request: MessagesRequest = {
  model: "claude-sonnet-4.5",
  system: "SYSPROMPT",
  messages: [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
  ],
};
const built = buildPayload(request, "claude-sonnet-4.5", "arn:test", "conv-1");
const history = built.payload.conversationState.history as KiroHistoryEntry[];
check("system prompt folded into first user turn", JSON.stringify(history[0]).includes("SYSPROMPT"));
eq(
  "current message is the last user turn",
  built.payload.conversationState.currentMessage.userInputMessage.content,
  "three",
);
eq("profileArn attached", built.payload.profileArn, "arn:test");
check("no empty toolUses array anywhere", !JSON.stringify(built.payload).includes('"toolUses":[]'));

const orphan = buildPayload(
  {
    model: "m",
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "go" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "missing", content: "orphaned" }] },
    ],
  },
  "m",
  undefined,
  "conv-2",
);
check("orphan tool result does not crash assembly", typeof orphan.payload === "object");

console.log("\n=== event-stream decoder ===");
const frame = (eventType: string, payloadText: string): Uint8Array => {
  const enc = new TextEncoder();
  const headerParts: number[] = [];
  const addHeader = (name: string, value: string): void => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    headerParts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  };
  addHeader(":event-type", eventType);
  addHeader(":message-type", "event");
  const headers = new Uint8Array(headerParts);
  const payload = enc.encode(payloadText);
  const total = 12 + headers.length + payload.length + 4;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, crc32(buf.subarray(0, 8)), false);
  buf.set(headers, 12);
  buf.set(payload, 12 + headers.length);
  view.setUint32(total - 4, crc32(buf.subarray(0, total - 4)), false);
  return buf;
};

const synthetic = frame("assistantResponseEvent", '{"content":"hello"}');
const decoded = new EventStreamDecoder().push(synthetic);
eq("synthetic frame decodes", decoded[0]?.headers[":event-type"], "assistantResponseEvent");

const splitDecoder = new EventStreamDecoder();
let splitFrames = 0;
for (let i = 0; i < synthetic.length; i += 3) {
  splitFrames += splitDecoder.push(synthetic.subarray(i, Math.min(i + 3, synthetic.length))).length;
}
eq("frame reassembled across chunk boundaries", splitFrames, 1);

let crcThrew = false;
const corrupt = new Uint8Array(synthetic);
corrupt[corrupt.length - 6] = (corrupt[corrupt.length - 6] as number) ^ 0xff;
try {
  new EventStreamDecoder().push(corrupt);
} catch {
  crcThrew = true;
}
check("corrupted frame rejected by CRC", crcThrew);

console.log("\n=== response assembly ===");
const builder = new ResponseBuilder();
builder.accept({ type: "assistantResponse", data: { content: "Hel" } });
builder.accept({ type: "assistantResponse", data: { content: "lo" } });
builder.accept({ type: "toolUse", data: { toolUseId: "t1", name: "get", input: '{"ci' } });
builder.accept({ type: "toolUse", data: { toolUseId: "t1", name: "get", input: 'ty":"Seoul"}' } });
builder.accept({ type: "toolUse", data: { toolUseId: "t1", name: "get", stop: true } });
builder.accept({ type: "metadata", data: { stopReason: "TOOL_USE" } });
const blocks = builder.blocks();
eq("text chunks concatenated", blocks[0], { type: "text", text: "Hello" });
eq("split tool json reassembled", (blocks[1] as { input: unknown }).input, { city: "Seoul" });
eq("stop reason maps to tool_use", builder.response("m", "prompt").stop_reason, "tool_use");
eq("malformed tool json degrades to empty object", parseToolInput('{"broken'), {});

if (Bun.env.KIRO_SELFTEST_LIVE !== "0") {
  console.log("\n=== live round trip ===");
  try {
    const cred = auth.load();
    check("credential loads from kiro-cli db", cred.accessToken.length > 0);

    const live = buildPayload(
      { model: "claude-sonnet-4.5", messages: [{ role: "user", content: "Reply with exactly: SELFTEST_OK" }] },
      "claude-sonnet-4.5",
      auth.profileArn,
      "selftest-live",
    );
    const liveBuilder = new ResponseBuilder();
    for await (const event of invoke(live.payload)) liveBuilder.accept(event);
    check("live response contains marker", liveBuilder.text.includes("SELFTEST_OK"), liveBuilder.text.slice(0, 80));
    check("metering reported", liveBuilder.credits > 0);

    // Token refresh is the one path that only runs once an hour, so a broken
    // request shape stays invisible until the token happens to expire mid-use.
    // Exercise it explicitly against the real endpoint.
    const fresh = await auth.forceRefresh();
    check("forced token refresh succeeds", fresh.length > 0);
    check("refreshed token differs or is valid", auth.load().expiresAt > Date.now());
  } catch (error) {
    check("live round trip", false, error instanceof Error ? error.message : String(error));
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
