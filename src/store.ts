import { BaseStore } from "@langchain/langgraph-checkpoint";
import type {
  GetOperation,
  Item,
  ListNamespacesOperation,
  Operation,
  OperationResults,
  PutOperation,
  SearchItem,
  SearchOperation,
} from "@langchain/langgraph-checkpoint";
import type { Memory, Mnemo, SearchHit } from "getmnemo";

import { isNotFound, resolveClient, type MnemoClientOptions } from "./client.js";
import { matchesFilter } from "./filter.js";
import {
  hasNamespacePrefix,
  namespaceToContainerTag,
  assertValidNamespace,
} from "./namespace.js";
import {
  buildItemMetadata,
  readItemKey,
  readItemNamespace,
  readItemValue,
  renderContent,
  toDate,
} from "./serialization.js";

/** LangGraph's own default page size for `search`. */
const DEFAULT_SEARCH_LIMIT = 10;
/** Hard cap enforced by `POST /v1/search`. */
const MAX_API_SEARCH_LIMIT = 50;
/** Hard cap enforced by `GET /v1/memories`. */
const MAX_API_PAGE_SIZE = 100;
/** Pages walked before a keyed lookup or unqueried search gives up. */
const DEFAULT_MAX_SCAN_PAGES = 20;
/**
 * Multiplier applied to `limit + offset` before hitting the API, so that
 * in-process namespace/filter narrowing still has candidates left over.
 */
const SEARCH_OVERFETCH = 3;

export interface MnemoStoreOptions extends MnemoClientOptions {
  /**
   * Pin EVERY namespace to this one Mnemo container instead of deriving a
   * container per namespace.
   *
   * SECURITY: the container tag is the tenant-isolation boundary. It is
   * developer/server-supplied — never model-supplied, and never read from graph
   * state. Pinning is the right mode for a per-user graph run: one user, one
   * container, namespaces kept apart by item metadata.
   */
  containerTag?: string;
  /** Items fetched per `GET /v1/memories` page. Clamped to the API max of 100. */
  pageSize?: number;
  /** Pages walked before a keyed lookup gives up. Default 20 (≈2000 items). */
  maxScanPages?: number;
  /** Metadata merged into every written item. Reserved fields still win. */
  metadata?: Record<string, unknown>;
}

/**
 * LangGraph `BaseStore` backed by Mnemo — long-term, cross-thread memory for a
 * compiled graph (`graph.compile({ store })`).
 *
 * Namespace tuples map to Mnemo container tags (see `./namespace.ts`), or to a
 * single pinned container when `containerTag` is set.
 *
 * NOT every `BaseStore` guarantee is exact on top of a semantic memory API.
 * The README documents the full table; the short version:
 *
 *  - `get` / `put` / `delete` are exact, addressed by `metadata.key`.
 *  - `search({ query })` is SEMANTIC — it ranks by relevance and does not
 *    return every matching item.
 *  - `search` covers the container the prefix maps to, not descendant
 *    containers, unless the store is pinned to one container.
 *  - `filter` is applied in-process, after retrieval.
 *  - `listNamespaces` THROWS — Mnemo containers are not enumerable.
 */
export class MnemoStore extends BaseStore {
  readonly #client: Mnemo;
  readonly #containerTag: string | undefined;
  readonly #pageSize: number;
  readonly #maxScanPages: number;
  readonly #metadata: Record<string, unknown>;
  /** `namespace|key` -> memory id, to skip the scan on repeat access. */
  readonly #idCache = new Map<string, string>();

  constructor(options: MnemoStoreOptions = {}) {
    super();
    this.#client = resolveClient(options, "MnemoStore");
    const pinned = options.containerTag?.trim();
    if (options.containerTag !== undefined && !pinned) {
      throw new Error(
        "MnemoStore: `containerTag` was provided but is empty. Omit it to derive " +
          "a container per namespace, or pass a real tag such as \"user:jane\".",
      );
    }
    this.#containerTag = pinned;
    this.#pageSize = Math.min(
      MAX_API_PAGE_SIZE,
      Math.max(1, options.pageSize ?? MAX_API_PAGE_SIZE),
    );
    this.#maxScanPages = Math.max(1, options.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES);
    this.#metadata = options.metadata ?? {};
  }

  /**
   * Operations run SEQUENTIALLY, so a `put` earlier in the batch is visible to
   * a `get` later in the same batch (LangGraph's own `InMemoryStore` behaves
   * this way, and graph nodes rely on it).
   */
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const operation of operations) {
      results.push(await this.#execute(operation));
    }
    return results as OperationResults<Op>;
  }

  /** The container a namespace resolves to. Useful for debugging and tests. */
  containerTagFor(namespace: readonly string[]): string {
    if (this.#containerTag) {
      assertValidNamespace(namespace);
      return this.#containerTag;
    }
    return namespaceToContainerTag(namespace);
  }

  async #execute(operation: Operation): Promise<unknown> {
    if (isSearchOperation(operation)) return this.#search(operation);
    if (isPutOperation(operation)) return this.#put(operation);
    if (isGetOperation(operation)) return this.#get(operation);
    return this.#listNamespaces(operation);
  }

  async #get(operation: GetOperation): Promise<Item | null> {
    const memory = await this.#findMemory(operation.namespace, operation.key);
    return memory ? this.#toItem(memory, operation.namespace) : null;
  }

  async #put(operation: PutOperation): Promise<void> {
    if (operation.value === null) {
      await this.#delete(operation.namespace, operation.key);
      return;
    }
    const containerTag = this.containerTagFor(operation.namespace);
    const value = operation.value as Record<string, unknown>;
    const content = renderContent(value);
    const metadata = buildItemMetadata(
      operation.namespace,
      operation.key,
      value,
      this.#metadata,
    );
    const existing = await this.#findMemory(operation.namespace, operation.key);
    if (existing) {
      await this.#client.update(existing.id, { content, metadata });
      return;
    }
    const response = await this.#client.add({ content, containerTag, metadata });
    const created = response.items?.[0]?.id;
    if (created) {
      this.#idCache.set(cacheKey(operation.namespace, operation.key), created);
    }
  }

  async #delete(namespace: string[], key: string): Promise<void> {
    const memory = await this.#findMemory(namespace, key);
    // Deleting a key that was never written is a no-op, matching BaseStore.
    if (!memory) return;
    await this.#client.delete(memory.id);
    this.#idCache.delete(cacheKey(namespace, key));
  }

  async #search(operation: SearchOperation): Promise<SearchItem[]> {
    const containerTag = this.containerTagFor(operation.namespacePrefix);
    const limit = Math.max(1, operation.limit ?? DEFAULT_SEARCH_LIMIT);
    const offset = Math.max(0, operation.offset ?? 0);
    const query = operation.query?.trim();

    const candidates = query
      ? await this.#semanticCandidates(
          containerTag,
          query,
          limit + offset,
          operation.namespacePrefix,
        )
      : (await this.#scanContainer(containerTag)).map((memory) =>
          this.#toItem(memory, operation.namespacePrefix),
        );

    const matched = candidates.filter(
      (item) =>
        hasNamespacePrefix(operation.namespacePrefix, item.namespace) &&
        matchesFilter(item.value as Record<string, unknown>, operation.filter),
    );
    return matched.slice(offset, offset + limit);
  }

  async #semanticCandidates(
    containerTag: string,
    query: string,
    needed: number,
    fallbackNamespace: readonly string[],
  ): Promise<SearchItem[]> {
    const fetchLimit = Math.min(
      MAX_API_SEARCH_LIMIT,
      Math.max(1, needed * SEARCH_OVERFETCH),
    );
    try {
      const { results } = await this.#client.search({
        q: query,
        containerTag,
        limit: fetchLimit,
      });
      return results.map((hit) => this.#hitToSearchItem(hit, fallbackNamespace));
    } catch (error) {
      // A container with no memories yet 404s. For a read that means "nothing
      // stored", not a failure — otherwise the first search in every new graph
      // run throws.
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  #listNamespaces(_operation: ListNamespacesOperation): Promise<string[][]> {
    return Promise.reject(
      new Error(
        "MnemoStore.listNamespaces is not supported: Mnemo containers are not " +
          "enumerable through the public API, so the namespace tree cannot be " +
          "reconstructed. Track the namespaces your graph writes in your own " +
          "application state.",
      ),
    );
  }

  /** Exact keyed lookup: cached id first, then a bounded scan of the container. */
  async #findMemory(
    namespace: string[],
    key: string,
  ): Promise<Memory | null> {
    const containerTag = this.containerTagFor(namespace);
    const cached = this.#idCache.get(cacheKey(namespace, key));
    if (cached) {
      try {
        return await this.#client.get(cached);
      } catch (error) {
        // The memory was deleted out from under us — fall through to a scan
        // rather than reporting a stale hit.
        if (!isNotFound(error)) throw error;
        this.#idCache.delete(cacheKey(namespace, key));
      }
    }
    const memories = await this.#scanContainer(containerTag);
    for (const memory of memories) {
      if (readItemKey(memory.metadata) !== key) continue;
      const stored = readItemNamespace(memory.metadata);
      // In pinned mode one container holds several namespaces, so the
      // namespace has to match too — otherwise `["a"]/x` would return `["b"]/x`.
      if (stored && !arrayEquals(stored, namespace)) continue;
      this.#idCache.set(cacheKey(namespace, key), memory.id);
      return memory;
    }
    return null;
  }

  /** Walk `GET /v1/memories` pages up to `maxScanPages`. */
  async #scanContainer(containerTag: string): Promise<Memory[]> {
    const collected: Memory[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.#maxScanPages; page++) {
      let batch: Memory[];
      try {
        const response = await this.#client.list({
          containerTag,
          limit: this.#pageSize,
          ...(cursor ? { cursor } : {}),
        });
        batch = response.items ?? [];
        cursor = response.nextCursor ?? undefined;
      } catch (error) {
        if (isNotFound(error)) return collected;
        throw error;
      }
      collected.push(...batch);
      if (!cursor) break;
    }
    return collected;
  }

  #toItem(memory: Memory, fallbackNamespace: readonly string[]): SearchItem {
    return {
      namespace: readItemNamespace(memory.metadata) ?? [...fallbackNamespace],
      key: readItemKey(memory.metadata) ?? memory.id,
      value: readItemValue(memory.metadata, memory.content),
      createdAt: toDate(memory.createdAt),
      updatedAt: toDate(memory.updatedAt),
    };
  }

  /**
   * A memory written outside this store (e.g. by `remember_memory`) carries no
   * namespace envelope. It still belongs to the container the search ran
   * against, so it is attributed to the searched prefix rather than dropped —
   * otherwise agent-written memories would be invisible to `store.search`.
   */
  #hitToSearchItem(
    hit: SearchHit,
    fallbackNamespace: readonly string[],
  ): SearchItem {
    return {
      namespace: readItemNamespace(hit.metadata) ?? [...fallbackNamespace],
      key: readItemKey(hit.metadata) ?? hit.memoryId,
      value: readItemValue(hit.metadata, hit.content),
      createdAt: toDate(hit.createdAt),
      updatedAt: toDate(hit.updatedAt),
      score: typeof hit.score === "number" ? hit.score : undefined,
    };
  }
}

function cacheKey(namespace: readonly string[], key: string): string {
  return `${JSON.stringify(namespace)}|${key}`;
}

function arrayEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

// `Operation` is a union of plain interfaces with no discriminant field, so the
// shape checks below are the only way to narrow it. Order matters.
function isSearchOperation(operation: Operation): operation is SearchOperation {
  return "namespacePrefix" in operation;
}

function isPutOperation(operation: Operation): operation is PutOperation {
  return "namespace" in operation && "key" in operation && "value" in operation;
}

function isGetOperation(operation: Operation): operation is GetOperation {
  return "namespace" in operation && "key" in operation;
}
