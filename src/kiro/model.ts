/**
 * Model registry.
 *
 * Kiro's runtime endpoint (`runtime.<region>.kiro.dev`) has no model-listing
 * API, so this list cannot be discovered at runtime — every entry below was
 * verified by actually issuing a request and getting a 200 back. An unknown id
 * is still forwarded as-is: if Kiro adds a model, it works before this list
 * catches up, and an id that truly does not exist comes back as a clean 400
 * ("Invalid model ID or insufficient subscription level to use it").
 *
 * Availability depends on the signed-in account's subscription tier, so a model
 * here can still 400 for a different account.
 */
export const KNOWN_MODELS: readonly string[] = [
  "auto",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "deepseek-3.2",
  "glm-5",
  "minimax-m2.5",
  "minimax-m2.1",
  "qwen3-coder-next",
];

/**
 * Normalise an Anthropic-style model id to Kiro's spelling.
 *
 * Clients send things like `claude-opus-4-5-20260101`; Kiro wants
 * `claude-opus-4.5`. Strips a trailing date and converts the version dashes
 * back into dots, leaving anything else untouched.
 */
export const normalizeModel = (model: string): string => {
  let name = model.trim();

  // Drop a trailing 8-digit date stamp (`-20260101`) or a `-latest` suffix.
  name = name.replace(/-(\d{8}|latest)$/i, "");

  // `claude-opus-4-5` -> `claude-opus-4.5`, including multi-part versions.
  name = name.replace(/-(\d+)-(\d+)$/, "-$1.$2");

  return name;
};
