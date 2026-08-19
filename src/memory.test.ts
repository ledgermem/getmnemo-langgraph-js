import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mnemo } from "getmnemo";
import { withMnemoMemory } from "./memory.js";
import { RECALL_TOOL_NAME, REMEMBER_TOOL_NAME } from "./tools.js";

const add = vi.fn();
const search = vi.fn();
const list = vi.fn();

const client = { add, search, list } as unknown as Mnemo;

describe("withMnemoMemory", () => {
  beforeEach(() => {
    for (const fn of [add, search, list]) fn.mockReset();
    list.mockResolvedValue({ items: [], nextCursor: null });
    add.mockResolvedValue({ scopeKey: "user:jane", items: [{ id: "m1" }] });
    search.mockResolvedValue({ results: [] });
  });

  it("requires a containerTag", () => {
    expect(() => withMnemoMemory({ client, containerTag: " " })).toThrow(
      /`containerTag` is required/,
    );
  });

  it("returns a store and both tools", () => {
    const bundle = withMnemoMemory({ client, containerTag: "user:jane" });
    expect(bundle.store.containerTagFor(["memories", "user42"])).toBe(
      "user:jane",
    );
    expect(bundle.tools.recallTool.name).toBe(RECALL_TOOL_NAME);
    expect(bundle.tools.rememberTool.name).toBe(REMEMBER_TOOL_NAME);
    expect(bundle.client).toBe(client);
  });

  it("pins the store and both tools to the same container", async () => {
    const { store, tools } = withMnemoMemory({
      client,
      containerTag: "user:jane",
    });

    await store.put(["memories", "user42"], "profile", { name: "Ada" });
    await tools.rememberTool.invoke({ content: "Ada is vegetarian" });
    await tools.recallTool.invoke({ query: "diet" });

    for (const call of add.mock.calls) {
      expect(call[0].containerTag).toBe("user:jane");
    }
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: "user:jane" }),
    );
  });

  it("threads developer metadata into store writes and tool writes alike", async () => {
    const { store, tools } = withMnemoMemory({
      client,
      containerTag: "user:jane",
      metadata: { userId: "jane" },
    });

    await store.put(["memories", "user42"], "profile", { name: "Ada" });
    await tools.rememberTool.invoke({ content: "Ada is vegetarian" });

    for (const call of add.mock.calls) {
      expect(call[0].metadata).toMatchObject({ userId: "jane" });
    }
  });
});
