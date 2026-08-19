# getmnemo-langgraph

[Mnemo](https://mnemohq.com)-backed long-term memory for [LangGraph JS](https://langchain-ai.github.io/langgraphjs/).
A `BaseStore` you hand to `graph.compile({ store })`, plus two ready-made
`remember` / `recall` tools for your agent.

## Install

```bash
npm install getmnemo-langgraph @langchain/langgraph
```

`getmnemo` (the core SDK) is bundled as a dependency, so it is installed for
you. `@langchain/langgraph`, `@langchain/langgraph-checkpoint` (where
`BaseStore` lives), and `@langchain/core` are peers — installing LangGraph
brings all three.

Set `GETMNEMO_API_KEY` and `GETMNEMO_WORKSPACE_ID`, or pass them in explicitly.

> **Security:** the `apiKey` is **full-access** by default — keep it
> server-side. For client-exposed contexts, mint a **scoped read-only key** at
> [app.mnemohq.com/settings/api-keys](https://app.mnemohq.com/settings/api-keys).

## Quickstart (30 seconds)

`withMnemoMemory` gives you a store and both tools, wired to the **same**
container:

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { withMnemoMemory } from "getmnemo-langgraph";

// containerTag is the tenant boundary — build one bundle per user, server-side.
const { store, tools } = withMnemoMemory({ containerTag: `user:${userId}` });

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [tools.recallTool, tools.rememberTool],
  store,
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "What did I tell you about my coffee?" }],
});
```

The agent calls `recall_memory` before answering and `remember_memory` when it
learns something worth keeping. Both hit Mnemo directly — nothing to persist
yourself.

## The store on its own

`MnemoStore` is a plain `BaseStore`, so every LangGraph store API works:

```ts
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { MnemoStore } from "getmnemo-langgraph";

const store = new MnemoStore(); // reads GETMNEMO_API_KEY / GETMNEMO_WORKSPACE_ID

// Write — the namespace tuple picks the container, the key addresses the item.
await store.put(["memories", "user42"], "profile", { name: "Ada", tz: "PKT" });

// Read back by exact key.
const item = await store.get(["memories", "user42"], "profile");
console.log(item?.value); // { name: "Ada", tz: "PKT" }

// Semantic search across the namespace.
const hits = await store.search(["memories", "user42"], {
  query: "who lives in Pakistan?",
  limit: 5,
});

const graph = new StateGraph(MessagesAnnotation);
// ... add nodes / edges ...
const app = graph.compile({ store });
```

Inside a node the store arrives on `config.store`, as usual:

```ts
const rememberNode = async (state, config) => {
  await config.store?.put(["memories", userId], "last_topic", {
    content: "billing",
  });
  return {};
};
```

## Namespaces map to containers (the isolation boundary)

Every Mnemo memory lives in a **container** — the tenant-isolation boundary,
tagged `<type>:<id>`. LangGraph addresses items by a namespace tuple, so the two
are translated like this:

| Namespace                          | Container tag              |
| ---------------------------------- | -------------------------- |
| `["memories", "user42"]`           | `memories:user42`          |
| `["memories", "user42", "prefs"]`  | `memories:user42:prefs`    |
| `["users"]`                        | `store:users`              |
| `[]`                               | throws — nothing to address |

A single-segment namespace gets the `store:` prefix because a bare segment is
not a valid `<type>:<id>` tag. Segments may not be empty, may not contain `":"`,
and may not be padded with whitespace — all three would let two distinct
namespaces collapse onto **one** container.

### Pinning to one container

Pass `containerTag` and every namespace resolves to that single container, with
namespaces kept apart by item metadata. This is what `withMnemoMemory` does, and
it is the right shape for a per-user graph run:

```ts
const store = new MnemoStore({ containerTag: `user:${userId}` });
```

In pinned mode `search(["a"])` narrows to items whose namespace starts with
`["a"]`, and `search([])` returns everything in the container.

> **The container tag is never model-facing.** It is supplied by you,
> server-side, and is deliberately absent from both tool schemas
> (`additionalProperties: false` keeps it out). A model — or a prompt-injection
> attacker steering one — cannot redirect a read or a write to another tenant.

## Exact vs approximated

Mnemo is a semantic memory API, not a key-value database, so not every
`BaseStore` guarantee survives verbatim. Precisely what you get:

| Operation | Status | Notes |
| --------- | ------ | ----- |
| `put(namespace, key, value)` | **Exact** | Writes one memory. Re-putting the same key patches the existing memory in place instead of duplicating it. |
| `get(namespace, key)` | **Exact** | Keyed lookup via `metadata.key`, resolved through an id cache and, on a miss, a bounded scan of the container (`maxScanPages` × 100 items, default 2000). Beyond that bound a `get` can return `null` for an item that exists. |
| `delete(namespace, key)` | **Exact** | Deletes the backing memory. Deleting an unknown key is a no-op. |
| `search(prefix, { query })` | **Approximated** | Semantic retrieval ranked by relevance, capped by the API at 50 candidates. It returns the *most relevant* items, not *all* matching ones, and each hit carries a `score`. |
| `search(prefix)` (no query) | **Exact, bounded** | Lists the container, same scan bound as `get`. |
| `search` across a namespace **prefix** | **Approximated** | Namespaces map to flat containers, so a prefix does **not** fan out to descendant containers — `search(["memories"])` will not reach items under `["memories", "user42"]`. Inside a **pinned** container prefix matching works properly. |
| `filter` | **Approximated** | Applied in-process after retrieval (`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte` supported). It narrows what the API already returned; it never widens the candidate set. |
| `offset` | **Approximated** | Applied in-process after retrieval, so `offset + limit` past the API's 50-candidate cap comes back short. |
| `index` (per-item embedding fields) | **Ignored** | Mnemo decides its own indexing; the argument is accepted and dropped. |
| `listNamespaces()` | **Throws** | Mnemo containers are not enumerable through the public API, so the namespace tree cannot be reconstructed. It throws with that message rather than returning a wrong answer. Track the namespaces your graph writes in your own state. |
| `batch()` | **Exact** | Operations run sequentially, so a `put` earlier in a batch is visible to a `get` later in the same batch. |

### How a value is stored

A LangGraph value is an object; a Mnemo memory is text plus metadata. Both are
kept:

- **`content`** — the text Mnemo embeds. A `content`, `text`, or `memory` string
  field in your value is used verbatim (that is the prose you meant); anything
  else is rendered as `key: value` lines, which embeds far better than raw JSON.
- **`metadata.value`** — your value, verbatim, so `get`/`search` round-trip it
  exactly.
- **`metadata.key` / `metadata.namespace`** — what makes the item addressable.

`key`, `namespace`, and `value` are **reserved** metadata fields. Anything you
pass as `metadata` on the store is merged underneath them.

Memories written by `remember_memory` (or by any other Mnemo client) carry no
key envelope. They live in the same container and **do** come back from
`store.search({ query })` — keyed by their memory id, with their prose exposed
as `{ content }` — but they are not addressable via `store.get`.

## Tools without the store

Need only the tools:

```ts
import { createMnemoTools } from "getmnemo-langgraph";

const { recallTool, rememberTool } = createMnemoTools({
  containerTag: `user:${userId}`,   // required — the tenant boundary
  defaultLimit: 8,                  // used when the model omits `limit`
  metadata: { userId },             // trusted; wins over model-supplied tags
});
```

| Tool | Name the model sees | Input |
| ---- | ------------------- | ----- |
| `recallTool` | `recall_memory` | `{ query: string, limit?: 1–50 }` |
| `rememberTool` | `remember_memory` | `{ content: string, tags?: object }` |

Both return a JSON string. Neither exposes `containerTag`, `scope`, or
`workspaceId`.

## Options

### `MnemoStore`

| Option | Default | Description |
| ------ | ------- | ----------- |
| `client` | — | Existing `Mnemo` instance (overrides `apiKey`/`workspaceId`). |
| `apiKey` | env | Full-access — keep server-side. Falls back to `GETMNEMO_API_KEY`. |
| `workspaceId` | env | Falls back to `GETMNEMO_WORKSPACE_ID`. |
| `containerTag` | — | Pin every namespace to one container instead of deriving one per namespace. |
| `pageSize` | `100` | Items per list page. Clamped to the API max of 100. |
| `maxScanPages` | `20` | Pages walked before a keyed lookup gives up (≈2000 items). |
| `metadata` | `{}` | Merged into every written item. Reserved fields still win. |

### `withMnemoMemory` / `createMnemoTools`

| Option | Default | Description |
| ------ | ------- | ----------- |
| `containerTag` | **required** | The tenant boundary for every read and write. |
| `defaultLimit` | `5` | Result count when the model omits `limit`. |
| `metadata` | `{}` | Trusted metadata merged into every write. |

## Roadmap

**No checkpointer in 0.1.0.** A `BaseCheckpointSaver` is a much bigger
contract than a store — thread checkpoints, pending writes, checkpoint
ancestry, and forking all have to be exactly right, and a half-implemented
checkpointer corrupts graphs in ways that are painful to debug. This release
deliberately ships only long-term memory, which is where Mnemo actually adds
something you cannot get from `MemorySaver`. Keep using LangGraph's own
checkpointers (`MemorySaver`, `@langchain/langgraph-checkpoint-postgres`)
alongside this store — they compose:

```ts
const app = graph.compile({ store, checkpointer: new MemorySaver() });
```

Also on the list: server-side metadata filtering (once the API contract is
public) and `listNamespaces` support (once containers are enumerable).

## Docs

Full documentation at [mnemohq.com](https://mnemohq.com).

## License

MIT
