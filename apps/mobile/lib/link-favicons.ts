import { rpc } from "./api";

// The server queues and bounds each lookup well inside this, so a slow site resolves to a miss
// on the server instead of an aborted request here.
const FAVICON_TIMEOUT_MS = 15_000;

/** A link's site icon from our API, which fetches and caches it; the phone never asks the site. */
export function loadLinkFavicon(origin: string): Promise<{ icon: string | null; retry?: boolean }> {
  return rpc("links/favicon", { origin }, { timeoutMs: FAVICON_TIMEOUT_MS });
}
