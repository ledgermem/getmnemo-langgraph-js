import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mnemo } from "getmnemo";
import {
  createMnemoTools,
  RECALL_TOOL_NAME,
  REMEMBER_TOOL_NAME,
} from "./tools.js";

const add = vi.fn();
const search = vi.fn();

// Fully mocked core client — these tests never touch the network.
const client = { add, search } as unknown as Mnemo;

const DEV_CONTAINER = "user:jane";

function tools(overrides: Record<string, unknown> = {}) {
  return createMnemoTools({
    client,
    containerTag: DEV_CONTAINER,
    ...overrides,
  });
}

/** The model-facing JSON schema attached to a built tool. */
function schemaOf(tool: { schema: unknown }): Record<string, unknown> {
  return tool.schema as Record<string, unknown>;
}

function propertiesOf(tool: { schema: unknown }): Record<string, unknown> {
  return schemaOf(tool).properties as Record<string, unknown>;
}

/** Resolve to how a promise settled, without letting the rejection escape. */
function settle(promise: Promise<unknown>): Promise<"resolved" | "rejected"> {
  return promise.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
}

describe("createMnemoTools", () => {
  beforeEach(() => {
    add.mockReset();
    search.mockReset();
    search.mockResolvedValue({
      results: [
        { memoryId: "m1", content: "Ada prefers dark roast", score: 0.9 },
      ],
    });
    add.mockResolvedValue({
      scopeKey: DEV_CONTAINER,
      items: [{ id: "m2", content: "Ada is vegetarian" }],
    });
  });

  it("requires a containerTag rather than defaulting the tenant scope", () => {
    expect(() => createMnemoTools({ client, containerTag: "  " })).toThrow(
      /`containerTag` is required/,
    );
  });

  it("exposes both tools under stable names", () => {
    const { recallTool, rememberTool } = tools();
    expect(recallTool.name).toBe(RECALL_TOOL_NAME);
    expect(rememberTool.name).toBe(REMEMBER_TOOL_NAME);
    expect(recallTool.description).toMatch(/long-term memory/i);
    expect(rememberTool.description).toMatch(/long-term memory/i);
  });

  describe("containerTag is not model-facing", () => {
    it("is absent from both tool schemas", () => {
      const { recallTool, rememberTool } = tools();
      for (const tool of [recallTool, rememberTool]) {
        const properties = propertiesOf(tool);
        expect(properties).not.toHaveProperty("containerTag");
        expect(properties).not.toHaveProperty("scope");
        expect(properties).not.toHaveProperty("workspaceId");
      }
      expect(Object.keys(propertiesOf(recallTool)).sort()).toEqual([
        "limit",
        "query",
      ]);
      expect(Object.keys(propertiesOf(rememberTool)).sort()).toEqual([
        "content",
        "tags",
      ]);
    });

    it("locks the schemas down with additionalProperties: false", () => {
      const { recallTool, rememberTool } = tools();
      expect(schemaOf(recallTool).additionalProperties).toBe(false);
      expect(schemaOf(rememberTool).additionalProperties).toBe(false);
    });

    it("never lets a model-supplied containerTag reach a read", async () => {
      const { recallTool } = tools();
      const outcome = await settle(
        recallTool.invoke({ query: "coffee", containerTag: "user:victim" }),
      );

      // `additionalProperties: false` makes the extra key a schema violation,
      // so the call is expected to be rejected outright. A core version that
      // strips unknown keys instead is also fine — as long as the read still
      // runs against the DEVELOPER's container.
      if (outcome === "rejected") {
        expect(search).not.toHaveBeenCalled();
      } else {
        expect(search).toHaveBeenCalledTimes(1);
        expect(search.mock.calls[0][0].containerTag).toBe(DEV_CONTAINER);
      }
    });

    it("never lets a model-supplied containerTag reach a write", async () => {
      const { rememberTool } = tools();
      const outcome = await settle(
        rememberTool.invoke({ content: "hi", containerTag: "user:victim" }),
      );

      if (outcome === "rejected") {
        expect(add).not.toHaveBeenCalled();
      } else {
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0][0].containerTag).toBe(DEV_CONTAINER);
      }
    });
  });

  describe("recall", () => {
    it("searches the developer container and returns JSON results", async () => {
      const { recallTool } = tools();
      const raw = await recallTool.invoke({ query: "coffee" });

      expect(search).toHaveBeenCalledWith({
        q: "coffee",
        containerTag: DEV_CONTAINER,
        limit: 5,
      });
      expect(JSON.parse(raw as string)).toEqual({
        results: [
          { memoryId: "m1", content: "Ada prefers dark roast", score: 0.9 },
        ],
      });
    });

    it("honours defaultLimit when the model omits one", async () => {
      const { recallTool } = tools({ defaultLimit: 8 });
      await recallTool.invoke({ query: "coffee" });
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 8 }),
      );
    });

    it("never sends a limit past the API's cap of 50", async () => {
      const { recallTool } = tools();
      // The schema caps `limit` at 50, and the runtime clamp is a second line
      // of defence for a provider that ignores the bound.
      const outcome = await settle(
        recallTool.invoke({ query: "coffee", limit: 9999 }),
      );
      if (outcome === "rejected") {
        expect(search).not.toHaveBeenCalled();
      } else {
        expect(search.mock.calls[0][0].limit).toBeLessThanOrEqual(50);
      }
    });

    it("returns an empty result set when the container does not exist yet", async () => {
      const notFound = new Error("Container not found") as Error & {
        status: number;
      };
      notFound.status = 404;
      search.mockRejectedValue(notFound);

      const { recallTool } = tools();
      const raw = await recallTool.invoke({ query: "coffee" });
      expect(JSON.parse(raw as string)).toEqual({ results: [] });
    });
  });

  describe("remember", () => {
    it("writes to the developer container and echoes the stored ids", async () => {
      const { rememberTool } = tools();
      const raw = await rememberTool.invoke({ content: "Ada is vegetarian" });

      expect(add).toHaveBeenCalledWith({
        content: "Ada is vegetarian",
        containerTag: DEV_CONTAINER,
        metadata: {},
      });
      expect(JSON.parse(raw as string)).toEqual({
        saved: 1,
        items: [{ id: "m2", content: "Ada is vegetarian" }],
      });
    });

    it("lets trusted metadata win over model-supplied tags", async () => {
      const { rememberTool } = tools({ metadata: { userId: "jane" } });
      await rememberTool.invoke({
        content: "Ada is vegetarian",
        tags: { userId: "victim", topic: "diet" },
      });

      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { topic: "diet", userId: "jane" },
        }),
      );
    });
  });
});
