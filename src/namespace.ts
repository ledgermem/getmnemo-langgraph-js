/**
 * LangGraph namespace tuples <-> Mnemo container tags.
 *
 * LangGraph addresses items by a hierarchical namespace tuple
 * (`["memories", "user42"]`). Mnemo addresses them by a FLAT container tag in
 * `<type>:<id>` form (`"memories:user42"`), which is the tenant-isolation
 * boundary. This module is the only place the two are translated.
 */

/**
 * Container type used when a namespace has a single segment. Mnemo requires a
 * `<type>:<id>` tag, so `["memories"]` cannot map to `"memories"` on its own.
 */
export const SINGLE_SEGMENT_CONTAINER_TYPE = "store";

/** Metadata key holding the LangGraph item key. Reserved — do not reuse. */
export const KEY_METADATA_FIELD = "key";
/** Metadata key holding the LangGraph namespace tuple. Reserved. */
export const NAMESPACE_METADATA_FIELD = "namespace";
/** Metadata key holding the verbatim LangGraph item value. Reserved. */
export const VALUE_METADATA_FIELD = "value";

/**
 * Reject namespace segments that cannot round-trip through a container tag.
 *
 * SECURITY: a segment containing `":"` would let `["a:b", "c"]` and
 * `["a", "b", "c"]` collapse onto the SAME container tag (`"a:b:c"`) — one
 * namespace could then read or overwrite another's memories. The API also
 * trims `<type>` and `<id>`, so a padded segment (`"a "`) would collide with
 * its trimmed twin. Both are rejected up front rather than silently merged.
 */
export function assertValidNamespace(namespace: readonly string[]): void {
  if (!Array.isArray(namespace)) {
    throw new TypeError(
      `MnemoStore: namespace must be an array of strings, received ${typeof namespace}.`,
    );
  }
  for (const segment of namespace) {
    if (typeof segment !== "string") {
      throw new TypeError(
        `MnemoStore: namespace segments must be strings, received ${typeof segment}.`,
      );
    }
    if (segment.length === 0 || segment.trim().length === 0) {
      throw new Error(
        `MnemoStore: namespace segments must be non-empty — got ${JSON.stringify(namespace)}.`,
      );
    }
    if (segment !== segment.trim()) {
      throw new Error(
        `MnemoStore: namespace segment ${JSON.stringify(segment)} has leading or ` +
          "trailing whitespace. Mnemo trims container tags, so the padded and " +
          "unpadded forms would collide on one container.",
      );
    }
    if (segment.includes(":")) {
      throw new Error(
        `MnemoStore: namespace segment ${JSON.stringify(segment)} may not contain ":" — ` +
          'container tags are built by joining segments with ":", so a colon inside ' +
          "a segment would collapse two distinct namespaces onto one container.",
      );
    }
  }
}

/**
 * Map a namespace tuple to a Mnemo container tag.
 *
 *  - `["memories", "user42"]` -> `"memories:user42"`
 *  - `["memories", "user42", "prefs"]` -> `"memories:user42:prefs"`
 *    (Mnemo splits on the FIRST colon, so `<type>` is `memories` and `<id>` is
 *    `user42:prefs` — still one distinct container.)
 *  - `["users"]` -> `"store:users"` (a bare segment is not a valid tag)
 *  - `[]` -> throws; there is no container to address.
 */
export function namespaceToContainerTag(namespace: readonly string[]): string {
  assertValidNamespace(namespace);
  if (namespace.length === 0) {
    throw new Error(
      "MnemoStore: an empty namespace cannot be mapped to a Mnemo container. " +
        "Pass at least one segment, or construct the store with an explicit " +
        "`containerTag` to pin every namespace to one container.",
    );
  }
  if (namespace.length === 1) {
    return `${SINGLE_SEGMENT_CONTAINER_TYPE}:${namespace[0]}`;
  }
  return namespace.join(":");
}

/** True when `namespace` starts with every segment of `prefix`. */
export function hasNamespacePrefix(
  prefix: readonly string[],
  namespace: readonly string[],
): boolean {
  if (prefix.length > namespace.length) return false;
  return prefix.every((segment, i) => namespace[i] === segment);
}
