vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeSessionRejected } from "./api";
import { loadLinkFavicon } from "./link-favicons";
import { restoreSessionToken } from "./session";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));

describe("link favicons on mobile", () => {
  beforeEach(async () => {
    await restoreSessionToken("session-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the API for an origin's icon", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ json: { icon: "data:image/png;base64,AAAA" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadLinkFavicon("https://x.com")).resolves.toEqual({
      icon: "data:image/png;base64,AAAA",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/rpc\/links\/favicon$/),
      expect.objectContaining({ body: JSON.stringify({ json: { origin: "https://x.com" } }) }),
    );
  });

  it.each([
    ["an oRPC not-found error", JSON.stringify({ json: { code: "NOT_FOUND", status: 404 } })],
    ["a plain not-found page", "Cannot POST /rpc/links/favicon"],
  ])("fails quietly on an older server that answers %s", async (_name, body) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const rejected = vi.fn();
    const unsubscribe = subscribeSessionRejected(rejected);

    // The renderer turns the rejection into the globe and remembers it for the session.
    await expect(loadLinkFavicon("https://x.com")).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
    unsubscribe();
  });
});
