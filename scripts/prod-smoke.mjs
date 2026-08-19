#!/usr/bin/env node
/**
 * CI prod smoke gate for `getmnemo-langgraph` (the LangGraph `BaseStore`).
 *
 * A REAL round-trip against PRODUCTION through the BUILT store in `./dist`.
 * The publish workflow gates `publish` on `needs: smoke`, so a red run here
 * blocks the release.
 *
 * The CRITICAL path is the store round-trip — `put()` then `get()` (exact,
 * keyed) then `search({ query })` (semantic) then `delete()`. It needs NO LLM
 * and is ALWAYS exercised.
 *
 * The second gate is TENANT ISOLATION. The namespace tuple is what derives the
 * Mnemo container, so a `search` under a different namespace must NOT see the
 * memory written under this run's namespace. A leak there is a PRODUCTION
 * cross-container security finding, not a flaky test.
 *
 * Exit codes:
 *   0  round-trip (put/get/search/delete) green AND no cross-namespace leak.
 *   1  missing required env, round-trip failure, or — loudest of all — a
 *      tenant-isolation leak.
 *
 * Required env:
 *   MNEMO_API_KEY        scoped test key (needs delete scope for cleanup)
 *   MNEMO_WORKSPACE_ID   throwaway test workspace id
 *   MNEMO_TEST_CONTAINER base container id stem, e.g. "ci-smoke"
 */

import { Mnemo } from "getmnemo";
import { MnemoStore } from "../dist/index.js";

// Give the indexer a moment between the write and the semantic read.
const PROPAGATION_WAIT_MS = 3_000;

/**
 * Assertion failures THROW rather than process.exit(1): exit() inside the try
 * would tear the process down without running the finally-cleanup, stranding
 * the run's memory in the production workspace (containers are not
 * enumerable, so orphans are unreachable forever).
 */
class SmokeFailure extends Error {}

function fail(msg) {
  throw new SmokeFailure(msg);
}

/** LOUD failure for a server-side tenant-isolation leak. */
function isolationFailure(detail) {
  const banner = "=".repeat(72);
  console.error(`\n${banner}`);
  console.error("TENANT ISOLATION FAILURE");
  console.error(banner);
  console.error(
    "A store search scoped to one namespace returned an item written under a\n" +
      "DIFFERENT namespace. Namespaces map to distinct Mnemo containers, so this\n" +
      "is a PRODUCTION cross-container security finding, NOT a flaky test and\n" +
      "NOT an SDK bug.\n\n" +
      "This outranks the launch: STOP, fix the server, and do NOT iterate the\n" +
      "SDK around it. Publish is correctly blocked.",
  );
  console.error(`\nDetail: ${detail}`);
  console.error(`${banner}\n`);
  throw new SmokeFailure("tenant-isolation leak (see banner above)");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if any hit's value carries `needle` anywhere in it. */
function hitsContain(hits, needle) {
  if (!Array.isArray(hits)) return false;
  return hits.some((hit) => JSON.stringify(hit?.value ?? {}).includes(needle));
}

async function main() {
  const apiKey = process.env.MNEMO_API_KEY;
  const workspaceId = process.env.MNEMO_WORKSPACE_ID;
  const base = process.env.MNEMO_TEST_CONTAINER;

  if (!apiKey) fail("MNEMO_API_KEY is not set");
  if (!workspaceId) fail("MNEMO_WORKSPACE_ID is not set");
  if (!base) fail("MNEMO_TEST_CONTAINER is not set");

  // Unique per-run nonce so concurrent / re-run smokes never collide and a
  // leftover memory from a prior run cannot masquerade as this run's data.
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // `base` is the container-id stem (e.g. "ci-smoke"); strip a leading
  // "<type>:" if the caller included one — the namespace supplies the type.
  const stem = base.includes(":") ? base.slice(base.indexOf(":") + 1) : base;
  // Two namespaces -> two distinct containers ("smoke:ci-…" vs "smoke:other-…").
  const namespace = ["smoke", `ci-${stem}-${nonce}`];
  const otherNamespace = ["smoke", `ci-other-${stem}-${nonce}`];
  const key = "profile";
  const secret = `teal-${nonce}`;
  const value = { content: `my favorite color is ${secret}`, run: nonce };

  const client = new Mnemo({ apiKey, workspaceId });
  const store = new MnemoStore({ client });

  console.log("[smoke] run nonce :", nonce);
  console.log("[smoke] namespace :", JSON.stringify(namespace));
  console.log("[smoke] container :", store.containerTagFor(namespace));

  let wrote = false;

  try {
    // ---- CRITICAL PATH (a): put -> get (exact, keyed) --------------------
    await store.put(namespace, key, value);
    wrote = true;

    const item = await store.get(namespace, key);
    if (!item) {
      fail(`put/get round-trip failed: get(${JSON.stringify(namespace)}, "${key}") returned null.`);
    }
    // Key-order-insensitive compare: the API round-trips objects, not key order.
    const canonical = (v) => JSON.stringify(Object.fromEntries(Object.entries(v).sort()));
    if (canonical(item.value) !== canonical(value)) {
      fail(
        "put/get round-trip failed: the stored value did not come back verbatim. " +
          `expected=${JSON.stringify(value)} actual=${JSON.stringify(item.value)}`,
      );
    }
    console.log("[smoke] OK put + get: the item round-tripped exactly");

    // ---- CRITICAL PATH (a2): re-put -> get (PATCH by id) -----------------
    // Overwriting an existing key drives PATCH /v1/memories/:id — a by-id
    // route that requires the container on the query string. A graph loop
    // rewrites the same key every turn, so this is the hottest store op in
    // production and must not go unexercised by the release gate.
    const updatedValue = {
      content: `my favorite color is ${secret} (updated)`,
      run: nonce,
    };
    await store.put(namespace, key, updatedValue);
    const updated = await store.get(namespace, key);
    if (!updated) {
      fail("re-put round-trip failed: get() returned null after the overwrite.");
    }
    if (canonical(updated.value) !== canonical(updatedValue)) {
      fail(
        "re-put round-trip failed: the overwritten value did not come back. " +
          `expected=${JSON.stringify(updatedValue)} actual=${JSON.stringify(updated.value)}`,
      );
    }
    console.log("[smoke] OK re-put: the overwrite (PATCH by id) round-tripped");

    // Let the indexer make the write searchable before the semantic read.
    await sleep(PROPAGATION_WAIT_MS);

    // ---- CRITICAL PATH (b): semantic search -----------------------------
    const hits = await store.search(namespace, {
      query: "favorite color",
      limit: 10,
    });
    if (!hitsContain(hits, secret)) {
      fail(
        `search failed: "${secret}" did not come back from a semantic search of ` +
          `${JSON.stringify(namespace)}. hits=${JSON.stringify(hits)}`,
      );
    }
    console.log("[smoke] OK search: the semantic query recalled the stored item");

    // ---- ISOLATION GATE -------------------------------------------------
    const cross = await store.search(otherNamespace, {
      query: "favorite color",
      limit: 10,
    });
    if (hitsContain(cross, secret)) {
      isolationFailure(
        `"${secret}" (written under ${JSON.stringify(namespace)}) leaked into a ` +
          `search scoped to ${JSON.stringify(otherNamespace)}.`,
      );
    }
    console.log("[smoke] OK isolation: the item did NOT leak across namespaces");

    // ---- CRITICAL PATH (c): delete --------------------------------------
    await store.delete(namespace, key);
    wrote = false;
    const afterDelete = await store.get(namespace, key);
    if (afterDelete) {
      fail(
        `delete failed: get() still returned an item after delete. item=${JSON.stringify(afterDelete)}`,
      );
    }
    console.log("[smoke] OK delete: the key no longer resolves");
  } finally {
    // ---- CLEANUP: best-effort; failure warns, never fatal ---------------
    if (wrote) {
      try {
        await store.delete(namespace, key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[smoke] WARN: cleanup delete failed: ${msg}`);
      }
    }
  }

  console.log(
    "\n[smoke] PASS: store put/re-put/get/search/delete + namespace isolation green.",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    if (err instanceof SmokeFailure) {
      console.error(`\n[smoke] FAIL: ${err.message}`);
    } else {
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`\n[smoke] FAIL: unexpected error during smoke run:\n${msg}`);
    }
    process.exit(1);
  },
);
