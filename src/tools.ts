import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Mnemo } from "getmnemo";

import { isNotFound, resolveClient, type MnemoClientOptions } from "./client.js";

/** Tool name the model sees when writing a memory. */
export const REMEMBER_TOOL_NAME = "remember_memory";
/** Tool name the model sees when reading memory. */
export const RECALL_TOOL_NAME = "recall_memory";

const DEFAULT_RECALL_LIMIT = 5;
/** Hard cap enforced by `POST /v1/search`. */
const MAX_RECALL_LIMIT = 50;

export interface MnemoToolsOptions extends MnemoClientOptions {
  /**
   * REQUIRED. The container (e.g. `"user:jane"`) every memory read and write is
   * scoped to.
   *
   * SECURITY: this is the TENANT-ISOLATION BOUNDARY and is supplied by YOU, the
   * developer, server-side. It is deliberately absent from the model-facing
   * schemas below, so a model — or a prompt-injection attacker steering it —
   * can never read or write another tenant's memories.
   */
  containerTag: string;
  /** Result count when the model omits `limit`. Default 5. */
  defaultLimit?: number;
  /** Trusted metadata merged into every written memory (e.g. `{ userId }`). */
  metadata?: Record<string, unknown>;
}

export interface MnemoTools {
  /** Writes a fact to long-term memory. */
  rememberTool: StructuredToolInterface;
  /** Reads relevant facts back out of long-term memory. */
  recallTool: StructuredToolInterface;
}

// JSON Schema rather than zod: it keeps this package free of a zod dependency
// (and of the zod 3/4 split), and `tool()` accepts it in every supported
// @langchain/core version.
//
// SECURITY: `containerTag` / `scope` / `workspaceId` are DELIBERATELY ABSENT.
// The container is injected below from developer config. Do NOT add them here.
const RECALL_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    query: {
      type: "string" as const,
      description: "Natural-language description of what to recall.",
    },
    limit: {
      type: "integer" as const,
      minimum: 1,
      maximum: MAX_RECALL_LIMIT,
      description: "Maximum number of memories to return.",
    },
  },
  required: ["query"],
};

const REMEMBER_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    content: {
      type: "string" as const,
      description: "The fact or preference to remember, in plain text.",
    },
    tags: {
      type: "object" as const,
      additionalProperties: true,
      description: "Optional structured tags, e.g. { topic: \"billing\" }.",
    },
  },
  required: ["content"],
};

/**
 * Build the pair of LangChain tools a LangGraph agent uses to read and write
 * Mnemo memory. Pass them straight to `createReactAgent({ tools })` or a
 * `ToolNode`.
 */
export function createMnemoTools(options: MnemoToolsOptions): MnemoTools {
  const containerTag = options.containerTag?.trim();
  if (!containerTag) {
    // Fail fast: an empty tag would either 400 at the API or silently fall back
    // to the client's default container. The isolation boundary must be set.
    throw new Error(
      "createMnemoTools: `containerTag` is required — it is the tenant scope " +
        'for every memory read and write (e.g. "user:jane"). Supply it server-side.',
    );
  }
  const client = resolveClient(options, "createMnemoTools");
  const defaultLimit = clampLimit(options.defaultLimit ?? DEFAULT_RECALL_LIMIT);
  const baseMetadata = options.metadata ?? {};

  const recallTool = tool(
    async (input: unknown) =>
      JSON.stringify(
        await recall(client, containerTag, asRecord(input), defaultLimit),
      ),
    {
      name: RECALL_TOOL_NAME,
      description:
        "Search the user's long-term memory for facts, preferences, or past " +
        "conversations relevant to the current turn. Call this before answering " +
        "anything that depends on what you already know about the user.",
      schema: RECALL_SCHEMA,
    },
  );

  const rememberTool = tool(
    async (input: unknown) =>
      JSON.stringify(
        await remember(client, containerTag, asRecord(input), baseMetadata),
      ),
    {
      name: REMEMBER_TOOL_NAME,
      description:
        "Save a new fact, preference, or noteworthy detail about the user to " +
        "long-term memory. Use sparingly — only for information worth recalling " +
        "in a future conversation.",
      schema: REMEMBER_SCHEMA,
    },
  );

  // `tool()` returns a `DynamicStructuredTool` whose generic parameters differ
  // between the @langchain/core versions this package supports, so the concrete
  // type is not portable. `StructuredToolInterface` is — and it is what
  // `createReactAgent` / `ToolNode` / `bindTools` actually consume.
  return {
    rememberTool: rememberTool as unknown as StructuredToolInterface,
    recallTool: recallTool as unknown as StructuredToolInterface,
  };
}

async function recall(
  client: Mnemo,
  containerTag: string,
  input: Record<string, unknown>,
  defaultLimit: number,
): Promise<unknown> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { error: "query is required" };
  // Clamp defensively. The schema bounds the model, but a non-conforming
  // provider response could still smuggle a huge value through and blow the
  // context window.
  const limit = clampLimit(Number(input.limit ?? defaultLimit), defaultLimit);
  try {
    // `containerTag` is injected here from developer config — NEVER from
    // `input`, which is model output.
    const { results } = await client.search({ q: query, containerTag, limit });
    return {
      results: results.map((hit) => ({
        memoryId: hit.memoryId,
        content: hit.content,
        score: hit.score,
      })),
    };
  } catch (error) {
    // A container with nothing in it yet 404s; for a recall that means "no
    // memories", not a tool failure.
    if (isNotFound(error)) return { results: [] };
    throw error;
  }
}

async function remember(
  client: Mnemo,
  containerTag: string,
  input: Record<string, unknown>,
  baseMetadata: Record<string, unknown>,
): Promise<unknown> {
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) return { error: "content is required" };
  const tags =
    typeof input.tags === "object" && input.tags !== null && !Array.isArray(input.tags)
      ? (input.tags as Record<string, unknown>)
      : {};
  // Model-supplied tags are spread FIRST so trusted server metadata (userId,
  // tenant, …) cannot be overwritten by a prompt-injected tool call.
  const metadata = { ...tags, ...baseMetadata };
  const response = await client.add({ content, containerTag, metadata });
  const items = (response.items ?? []).map((memory) => ({
    id: memory.id,
    content: memory.content,
  }));
  return { saved: items.length, items };
}

/**
 * Tool input is model output typed as `unknown` (JSON-schema tools are not
 * statically typed). Narrow it once, here, instead of trusting the shape.
 */
function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function clampLimit(requested: number, fallback = DEFAULT_RECALL_LIMIT): number {
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(MAX_RECALL_LIMIT, Math.max(1, Math.floor(requested)));
}
