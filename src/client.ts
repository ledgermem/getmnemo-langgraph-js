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
