/**
 * LangGraph store items <-> Mnemo memories.
 *
 * A LangGraph item is `{ namespace, key, value: Record<string, unknown> }`.
 * A Mnemo memory is a `content` STRING plus free-form `metadata`. We store the
 * verbatim value under `metadata.value` so reads round-trip exactly, and render
 * a human-readable `content` so the value is actually embeddable — semantic
 * search over `{"a":1}` is much worse than over `a: 1`.
 */

import {
  KEY_METADATA_FIELD,
  NAMESPACE_METADATA_FIELD,
  VALUE_METADATA_FIELD,
} from "./namespace.js";

/** Value fields treated as the memory's natural prose form, in priority order. */
const CONTENT_FIELDS = ["content", "text", "memory"] as const;

/**
 * Render a LangGraph value into the text Mnemo embeds and returns as `content`.
 *
 * A `content` / `text` / `memory` string field is used verbatim (that is the
 * prose the caller meant). Anything else is flattened to `key: value` lines,
 * which embeds far better than raw JSON.
 */
export function renderContent(value: Record<string, unknown>): string {
  for (const field of CONTENT_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  const lines = Object.entries(value).map(
    ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );
  const rendered = lines.join("\n").trim();
  // An empty object still has to produce non-empty content — the API rejects
  // a blank memory.
  return rendered.length > 0 ? rendered : JSON.stringify(value);
}

/** Build the metadata envelope written alongside every store item. */
export function buildItemMetadata(
  namespace: readonly string[],
  key: string,
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  // `extra` first so the reserved fields below always win — the envelope is
  // what makes get/delete addressable and must not be shadowed.
  return {
    ...extra,
    [KEY_METADATA_FIELD]: key,
    [NAMESPACE_METADATA_FIELD]: [...namespace],
    [VALUE_METADATA_FIELD]: value,
  };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** Read back the LangGraph item key, or `null` for a memory we did not write. */
export function readItemKey(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const key = record?.[KEY_METADATA_FIELD];
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Read back the namespace tuple, or `null` for a memory we did not write. */
export function readItemNamespace(metadata: unknown): string[] | null {
  const record = asRecord(metadata);
  const namespace = record?.[NAMESPACE_METADATA_FIELD];
  if (!Array.isArray(namespace)) return null;
  return namespace.every((s) => typeof s === "string")
    ? (namespace as string[])
    : null;
}

/**
 * Read back the verbatim value. Memories written outside this store (e.g. by
 * the `rememberTool`) carry no envelope — surface their prose as
 * `{ content }` so they still read as valid LangGraph items.
 */
export function readItemValue(
  metadata: unknown,
  fallbackContent: string,
): Record<string, unknown> {
  const record = asRecord(metadata);
  const value = asRecord(record?.[VALUE_METADATA_FIELD]);
  return value ?? { content: fallbackContent };
}

/** Parse an API timestamp, falling back to the epoch on malformed input. */
export function toDate(value: string | null | undefined): Date {
  if (!value) return new Date(0);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
