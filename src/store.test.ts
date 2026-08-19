import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mnemo } from "getmnemo";
import { MnemoStore } from "./store.js";

const add = vi.fn();
const get = vi.fn();
const list = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const search = vi.fn();

// The core client is fully mocked — these tests never touch the network.
const client = {
  add,
  get,
  list,
  update,
  delete: remove,
  search,
} as unknown as Mnemo;

/** Shape of a `Memory` as `GET /v1/memories` returns it (trimmed to what we read). */
function memory(
  id: string,
  content: string,
  metadata: Record<string, unknown> | null,
) {
  return {
    id,
    content,
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

function emptyContainer() {
  list.mockResolvedValue({ items: [], nextCursor: null });
}

function containerWith(...items: ReturnType<typeof memory>[]) {
  list.mockResolvedValue({ items, nextCursor: null });
}

function notFound() {
  const error = new Error("Container not found") as Error & { status: number };
  error.status = 404;
  return error;
}

describe("MnemoStore", () => {
  beforeEach(() => {
    for (const fn of [add, get, list, update, remove, search]) fn.mockReset();
    add.mockResolvedValue({ scopeKey: "memories:user42", items: [{ id: "m1" }] });
  });

  describe("namespace mapping", () => {
    it("derives a container per namespace", () => {
      const store = new MnemoStore({ client });
      expect(store.containerTagFor(["memories", "user42"])).toBe(
        "memories:user42",
      );
      expect(store.containerTagFor(["users"])).toBe("store:users");
    });

    it("pins every namespace to one container when containerTag is set", () => {
      const store = new MnemoStore({ client, containerTag: "user:jane" });
      expect(store.containerTagFor(["memories", "user42"])).toBe("user:jane");
      expect(store.containerTagFor(["anything"])).toBe("user:jane");
    });

    it("rejects an empty containerTag rather than silently deriving one", () => {
      expect(() => new MnemoStore({ client, containerTag: "  " })).toThrow(
        /is empty/,
      );
    });
  });

  describe("put", () => {
    it("adds a memory scoped to the namespace's container", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      await store.put(["memories", "user42"], "profile", { name: "Ada" });

      expect(add).toHaveBeenCalledWith({
        content: "name: Ada",
        containerTag: "memories:user42",
        metadata: {
          key: "profile",
          namespace: ["memories", "user42"],
          value: { name: "Ada" },
        },
      });
    });

    it("uses a `content` field verbatim so the memory embeds as prose", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      await store.put(["memories", "user42"], "k", {
        content: "Ada prefers dark roast",
        topic: "coffee",
      });
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ content: "Ada prefers dark roast" }),
      );
    });

    it("updates in place when the key already exists", async () => {
      containerWith(
        memory("m9", "name: Ada", {
          key: "profile",
          namespace: ["memories", "user42"],
          value: { name: "Ada" },
        }),
      );
      const store = new MnemoStore({ client });
      await store.put(["memories", "user42"], "profile", { name: "Grace" });

      expect(add).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(
        "m9",
        {
          content: "name: Grace",
          metadata: {
            key: "profile",
            namespace: ["memories", "user42"],
            value: { name: "Grace" },
          },
        },
        { containerTag: "memories:user42" },
      );
    });

    it("merges developer metadata without letting it shadow the envelope", async () => {
      emptyContainer();
      const store = new MnemoStore({
        client,
        metadata: { userId: "u1", key: "spoofed" },
      });
      await store.put(["memories", "user42"], "profile", { name: "Ada" });
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ userId: "u1", key: "profile" }),
        }),
      );
    });
  });

  describe("get", () => {
    it("returns the stored value round-tripped exactly", async () => {
      containerWith(
        memory("m9", "name: Ada", {
          key: "profile",
          namespace: ["memories", "user42"],
          value: { name: "Ada", tz: "PKT" },
        }),
      );
      const store = new MnemoStore({ client });
      const item = await store.get(["memories", "user42"], "profile");

      expect(item).not.toBeNull();
      expect(item?.key).toBe("profile");
      expect(item?.namespace).toEqual(["memories", "user42"]);
      expect(item?.value).toEqual({ name: "Ada", tz: "PKT" });
      expect(item?.createdAt).toBeInstanceOf(Date);
    });

    it("returns null for an unknown key", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      expect(await store.get(["memories", "user42"], "nope")).toBeNull();
    });

    it("returns null when the container does not exist yet (API 404)", async () => {
      list.mockRejectedValue(notFound());
      const store = new MnemoStore({ client });
      expect(await store.get(["memories", "user42"], "profile")).toBeNull();
    });

    it("does not cross namespaces inside one pinned container", async () => {
      containerWith(
        memory("m1", "x", { key: "shared", namespace: ["a"], value: { v: 1 } }),
        memory("m2", "y", { key: "shared", namespace: ["b"], value: { v: 2 } }),
      );
      const store = new MnemoStore({ client, containerTag: "user:jane" });
      expect((await store.get(["a"], "shared"))?.value).toEqual({ v: 1 });
      expect((await store.get(["b"], "shared"))?.value).toEqual({ v: 2 });
    });

    it("reuses the cached memory id instead of rescanning", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      await store.put(["memories", "user42"], "profile", { name: "Ada" });
      list.mockClear();
      get.mockResolvedValue(
        memory("m1", "name: Ada", {
          key: "profile",
          namespace: ["memories", "user42"],
          value: { name: "Ada" },
        }),
      );

      const item = await store.get(["memories", "user42"], "profile");
      expect(get).toHaveBeenCalledWith("m1", { containerTag: "memories:user42" });
      expect(list).not.toHaveBeenCalled();
      expect(item?.value).toEqual({ name: "Ada" });
    });

    it("falls back to a scan when a cached id was deleted elsewhere", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      await store.put(["memories", "user42"], "profile", { name: "Ada" });
      get.mockRejectedValue(notFound());
      list.mockResolvedValue({ items: [], nextCursor: null });

      expect(await store.get(["memories", "user42"], "profile")).toBeNull();
      expect(get).toHaveBeenCalledWith("m1", { containerTag: "memories:user42" });
    });
  });

  describe("search", () => {
    it("maps semantic hits to store items with scores", async () => {
      search.mockResolvedValue({
        results: [
          {
            memoryId: "m1",
            content: "name: Ada",
            score: 0.91,
            metadata: {
              key: "profile",
              namespace: ["memories", "user42"],
              value: { name: "Ada" },
            },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const store = new MnemoStore({ client });
      const hits = await store.search(["memories", "user42"], {
        query: "who is this user",
        limit: 5,
      });

      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "who is this user",
          containerTag: "memories:user42",
        }),
      );
      expect(hits).toHaveLength(1);
      expect(hits[0].key).toBe("profile");
      expect(hits[0].value).toEqual({ name: "Ada" });
      expect(hits[0].score).toBe(0.91);
    });

    it("surfaces tool-written memories that carry no key envelope", async () => {
      search.mockResolvedValue({
        results: [
          {
            memoryId: "m7",
            content: "Ada prefers dark roast",
            score: 0.8,
            metadata: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const store = new MnemoStore({ client, containerTag: "user:jane" });
      const hits = await store.search([], { query: "coffee" });

      expect(hits[0].key).toBe("m7");
      expect(hits[0].value).toEqual({ content: "Ada prefers dark roast" });
    });

    it("attributes envelope-less hits to the searched namespace", async () => {
      // Without this, a memory the agent wrote through `remember_memory` would
      // be filtered out of every non-empty prefix search.
      search.mockResolvedValue({
        results: [
          {
            memoryId: "m7",
            content: "Ada prefers dark roast",
            score: 0.8,
            metadata: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const store = new MnemoStore({ client });
      const hits = await store.search(["memories", "user42"], {
        query: "coffee",
      });

      expect(hits).toHaveLength(1);
      expect(hits[0].namespace).toEqual(["memories", "user42"]);
    });

    it("lists the container when no query is given", async () => {
      containerWith(
        memory("m1", "a", {
          key: "k1",
          namespace: ["memories", "user42"],
          value: { n: 1 },
        }),
        memory("m2", "b", {
          key: "k2",
          namespace: ["memories", "user42"],
          value: { n: 2 },
        }),
      );
      const store = new MnemoStore({ client });
      const hits = await store.search(["memories", "user42"]);

      expect(search).not.toHaveBeenCalled();
      expect(hits.map((h) => h.key)).toEqual(["k1", "k2"]);
    });

    it("applies filter and offset in-process", async () => {
      containerWith(
        memory("m1", "a", { key: "k1", namespace: ["ns", "x"], value: { n: 1 } }),
        memory("m2", "b", { key: "k2", namespace: ["ns", "x"], value: { n: 5 } }),
        memory("m3", "c", { key: "k3", namespace: ["ns", "x"], value: { n: 9 } }),
      );
      const store = new MnemoStore({ client });

      const gt = await store.search(["ns", "x"], { filter: { n: { $gt: 4 } } });
      expect(gt.map((h) => h.key)).toEqual(["k2", "k3"]);

      const offset = await store.search(["ns", "x"], { offset: 2 });
      expect(offset.map((h) => h.key)).toEqual(["k3"]);
    });

    it("narrows to the prefix inside a pinned container", async () => {
      containerWith(
        memory("m1", "a", { key: "k1", namespace: ["a", "1"], value: { n: 1 } }),
        memory("m2", "b", { key: "k2", namespace: ["b", "1"], value: { n: 2 } }),
      );
      const store = new MnemoStore({ client, containerTag: "user:jane" });
      const hits = await store.search(["a"]);
      expect(hits.map((h) => h.key)).toEqual(["k1"]);
    });

    it("returns [] when the container does not exist yet (API 404)", async () => {
      search.mockRejectedValue(notFound());
      const store = new MnemoStore({ client });
      expect(await store.search(["memories", "user42"], { query: "x" })).toEqual(
        [],
      );
    });
  });

  describe("delete", () => {
    it("deletes the memory backing the key", async () => {
      containerWith(
        memory("m9", "name: Ada", {
          key: "profile",
          namespace: ["memories", "user42"],
          value: { name: "Ada" },
        }),
      );
      remove.mockResolvedValue({ id: "m9", deleted: true });
      const store = new MnemoStore({ client });
      await store.delete(["memories", "user42"], "profile");
      expect(remove).toHaveBeenCalledWith("m9", { containerTag: "memories:user42" });
    });

    it("is a no-op for an unknown key", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      await store.delete(["memories", "user42"], "nope");
      expect(remove).not.toHaveBeenCalled();
    });

    it("re-adds rather than updating after a delete (cache is invalidated)", async () => {
      containerWith(
        memory("m9", "name: Ada", {
          key: "profile",
          namespace: ["memories", "user42"],
          value: { name: "Ada" },
        }),
      );
      remove.mockResolvedValue({ id: "m9", deleted: true });
      const store = new MnemoStore({ client });
      await store.delete(["memories", "user42"], "profile");

      emptyContainer();
      await store.put(["memories", "user42"], "profile", { name: "Grace" });
      expect(add).toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("batch", () => {
    it("runs operations in order so a later get sees an earlier put", async () => {
      emptyContainer();
      const store = new MnemoStore({ client });
      get.mockResolvedValue(
        memory("m1", "name: Ada", {
          key: "profile",
          namespace: ["ns", "x"],
          value: { name: "Ada" },
        }),
      );

      const [putResult, item] = await store.batch([
        { namespace: ["ns", "x"], key: "profile", value: { name: "Ada" } },
        { namespace: ["ns", "x"], key: "profile" },
      ]);

      expect(putResult).toBeUndefined();
      // The id cached by the put is what the get resolves through.
      expect(get).toHaveBeenCalledWith("m1", { containerTag: "ns:x" });
      expect(item).not.toBeNull();
    });
  });

  describe("listNamespaces", () => {
    it("throws with an actionable message instead of returning wrong data", async () => {
      const store = new MnemoStore({ client });
      await expect(store.listNamespaces()).rejects.toThrow(
        /not supported.*not\s+enumerable/s,
      );
    });
  });

  describe("credentials", () => {
    it("throws when neither a client nor apiKey/workspaceId is available", () => {
      const key = process.env.GETMNEMO_API_KEY;
      const workspace = process.env.GETMNEMO_WORKSPACE_ID;
      delete process.env.GETMNEMO_API_KEY;
      delete process.env.GETMNEMO_WORKSPACE_ID;
      try {
        expect(() => new MnemoStore()).toThrow(/missing apiKey\/workspaceId/);
      } finally {
        if (key !== undefined) process.env.GETMNEMO_API_KEY = key;
        if (workspace !== undefined) process.env.GETMNEMO_WORKSPACE_ID = workspace;
      }
    });
  });
});
