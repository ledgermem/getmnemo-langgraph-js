import { Mnemo } from "getmnemo";

/** Credentials accepted by every entry point in this package. */
export interface MnemoClientOptions {
  /** Pre-built core client. Wins over `apiKey` / `workspaceId`. */
  client?: Mnemo;
  /** Falls back to `GETMNEMO_API_KEY`. Full-access by default — keep it server-side. */
  apiKey?: string;
  /** Falls back to `GETMNEMO_WORKSPACE_ID`. */
  workspaceId?: string;
}

export function resolveClient(
  options: MnemoClientOptions,
  caller: string,
): Mnemo {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env.GETMNEMO_API_KEY;
  const workspaceId = options.workspaceId ?? process.env.GETMNEMO_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error(
      `${caller}: missing apiKey/workspaceId. Pass them explicitly, pass a ` +
        "pre-built `client`, or set GETMNEMO_API_KEY and GETMNEMO_WORKSPACE_ID.",
    );
  }
  return new Mnemo({ apiKey, workspaceId });
}

/** True for a 404 from the API — usually "container does not exist yet". */
export function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && (error as { status?: number }).status === 404
  );
}

/**
 * True for a by-id read that can no longer resolve under the container it was
 * scoped to: gone entirely (404/410) or not visible in this scope (400/403).
 * Only used to decide "drop the cached id and rescan", where matching a
 * broader status set is safe — the container scan is authoritative.
 */
export function isStaleByIdRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  return status === 400 || status === 403 || status === 404 || status === 410;
}
