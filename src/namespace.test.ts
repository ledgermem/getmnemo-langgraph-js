import { describe, expect, it } from "vitest";
import { hasNamespacePrefix, namespaceToContainerTag } from "./namespace.js";

describe("namespaceToContainerTag", () => {
  it("joins a multi-segment namespace with ':'", () => {
    expect(namespaceToContainerTag(["memories", "user42"])).toBe(
      "memories:user42",
    );
  });

  it("prefixes a single-segment namespace with the 'store' container type", () => {
    // Mnemo requires "<type>:<id>", so a bare segment is not a valid tag.
    expect(namespaceToContainerTag(["users"])).toBe("store:users");
  });

  it("keeps deep namespaces distinct (Mnemo splits on the first colon only)", () => {
    expect(namespaceToContainerTag(["memories", "user42", "prefs"])).toBe(
      "memories:user42:prefs",
    );
  });

  it("throws on an empty namespace", () => {
    expect(() => namespaceToContainerTag([])).toThrow(/empty namespace/);
  });

  it("rejects a segment containing ':' so two namespaces cannot collide", () => {
    // ["a:b", "c"] would otherwise produce the same tag as ["a", "b", "c"].
    expect(() => namespaceToContainerTag(["a:b", "c"])).toThrow(/may not contain/);
  });

  it("rejects padded segments (the API trims, so padded and unpadded collide)", () => {
    expect(() => namespaceToContainerTag(["memories ", "user42"])).toThrow(
      /whitespace/,
    );
  });

  it("rejects empty segments", () => {
    expect(() => namespaceToContainerTag(["memories", ""])).toThrow(/non-empty/);
  });
});

describe("hasNamespacePrefix", () => {
  it("matches an exact namespace", () => {
    expect(hasNamespacePrefix(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("matches a shorter prefix", () => {
    expect(hasNamespacePrefix(["a"], ["a", "b"])).toBe(true);
  });

  it("matches the empty prefix", () => {
    expect(hasNamespacePrefix([], ["a", "b"])).toBe(true);
  });

  it("rejects a longer prefix and a diverging path", () => {
    expect(hasNamespacePrefix(["a", "b"], ["a"])).toBe(false);
    expect(hasNamespacePrefix(["a", "c"], ["a", "b"])).toBe(false);
  });
});
