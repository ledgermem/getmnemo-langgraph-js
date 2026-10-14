import { Mnemo } from "getmnemo";

/** Credentials accepted by every entry point in this package. */
export interface MnemoClientOptions {
  /** Pre-built core client. Wins over `apiKey`. */
  client?: Mnemo;
  /** Falls back to `GETMNEMO_API_KEY`. Full-access by default — keep it server-side. */
  apiKey?: string;
  /**
   * @deprecated Workspace identity is taken from the API key in core 0.6.
   * Still accepted and forwarded for backwards compatibility. Falls back to
   * `GETMNEMO_WORKSPACE_ID`.
   */
  workspaceId?: string;
}

export function resolveClient(
  options: MnemoClientOptions,
  caller: string,
): Mnemo {
  if (options.client) return options.client;
  const apiKey = options.apiKey ?? process.env.GETMNEMO_API_KEY;
  // Deprecated in core 0.6 (workspace identity comes from the API key), but
  // still accepted and forwarded for backwards compatibility.
  const workspaceId = options.workspaceId ?? process.env.GETMNEMO_WORKSPACE_ID;
  if (!apiKey) {
    throw new Error(
      `${caller}: missing apiKey. Pass it explicitly, pass a pre-built ` +
        "`client`, or set GETMNEMO_API_KEY.",
    );
  }
  return new Mnemo({ apiKey, ...(workspaceId ? { workspaceId } : {}) });
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
