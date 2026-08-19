import type { Mnemo } from "getmnemo";

import { resolveClient, type MnemoClientOptions } from "./client.js";
import { MnemoStore } from "./store.js";
import { createMnemoTools, type MnemoTools } from "./tools.js";

export interface WithMnemoMemoryOptions extends MnemoClientOptions {
  /**
   * REQUIRED. The container every read and write is scoped to, e.g.
   * `"user:jane"`.
   *
   * SECURITY: the tenant-isolation boundary. Developer/server-supplied — it is
   * never exposed to the model and never derived from graph state. Build one
   * bundle per user (or per tenant) rather than sharing one across users.
   */
  containerTag: string;
  /** Result count when the model omits `limit` on `recall_memory`. Default 5. */
  defaultLimit?: number;
  /** Trusted metadata merged into every write (e.g. `{ userId }`). */
  metadata?: Record<string, unknown>;
}

export interface MnemoMemoryBundle {
  /** Pass to `graph.compile({ store })`. */
  store: MnemoStore;
  /** The two memory tools, ready for `createReactAgent({ tools })`. */
  tools: MnemoTools;
  /** The underlying core client, shared by the store and both tools. */
  client: Mnemo;
}

/**
 * One-call wiring for Mnemo-backed long-term memory in a LangGraph app.
 *
 * Returns a `store` (a `BaseStore` for `graph.compile({ store })`) and the
 * `remember_memory` / `recall_memory` tools — all pinned to the SAME container,
 * so anything the agent remembers through a tool is visible to `store.search`
 * and vice versa.
 *
 * ```ts
 * const { store, tools } = withMnemoMemory({ containerTag: `user:${userId}` });
 * const agent = createReactAgent({ llm, tools: [tools.recallTool, tools.rememberTool], store });
 * ```
 *
 * Note the split in addressing: `store.put`/`get` items carry a `key` and are
 * exactly addressable, while tool-written memories are free-form prose with no
 * key. Both live in the same container and both come back from
 * `store.search({ query })`; only keyed items come back from `store.get`.
 */
export function withMnemoMemory(
  options: WithMnemoMemoryOptions,
): MnemoMemoryBundle {
  const containerTag = options.containerTag?.trim();
  if (!containerTag) {
    throw new Error(
      "withMnemoMemory: `containerTag` is required — it is the tenant scope for " +
        'every memory read and write (e.g. "user:jane"). Supply it server-side.',
    );
  }
  // One client for the store and both tools: one connection pool, and the
  // container can only be configured in a single place.
  const client = resolveClient(options, "withMnemoMemory");
  const store = new MnemoStore({
    client,
    containerTag,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  const tools = createMnemoTools({
    client,
    containerTag,
    ...(options.defaultLimit !== undefined
      ? { defaultLimit: options.defaultLimit }
      : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  return { store, tools, client };
}
