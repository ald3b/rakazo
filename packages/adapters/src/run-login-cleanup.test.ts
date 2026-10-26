import type { ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider, NO_PAGE_BROWSER_MESSAGE } from "./computer-browser.js";
import { cleanUpEndedRunLogins } from "./run-login-cleanup.js";

const computer: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};
const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

function endedLogins(rows: Array<{ id: string; origin: string }>) {
  const left = [...rows];
  const prisma = {
    runLogin: {
      findMany: vi.fn(async () => [...left]),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in)
          left.splice(
            left.findIndex((row) => row.id === id),
            1,
          );
        return { count: where.id.in.length };
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, left };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ended run login cleanup", () => {
  it("closes each site once and drops its logins, keeping a site that couldn't be cleaned", async () => {
    const warn = vi.fn();
    vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    const { prisma, left } = endedLogins([
      { id: "a", origin: "https://login.example.test" },
      { id: "b", origin: "https://login.example.test" },
      { id: "c", origin: "https://other.example.test" },
    ]);
    const closeSite = vi.fn(async (_computer: ComputerRef, request: { origin: string }) => ({
      ok: request.origin === "https://login.example.test",
    }));
    const cleaned = await cleanUpEndedRunLogins({
      computerId: "computer-1",
      prisma,
      browser: { closeSite },
      computer,
      context,
      bot: { id: "bot-1", spaceId: "space-1" },
    });
    expect(closeSite.mock.calls.map(([, request]) => request)).toEqual([
      { origin: "https://login.example.test" },
      { origin: "https://other.example.test" },
    ]);
    expect(left).toEqual([{ id: "c", origin: "https://other.example.test" }]);
    expect(cleaned).toBe(false);
    // A retry is logged without the site or the login.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("example.test");
  });

  it("keeps the logins when the computer can't be reached", async () => {
    vi.spyOn(Logging, "getLogger").mockReturnValue({ warn: vi.fn() } as never);
    const { prisma, left } = endedLogins([{ id: "a", origin: "https://login.example.test" }]);
    await cleanUpEndedRunLogins({
      computerId: "computer-1",
      prisma,
      browser: { closeSite: vi.fn(async () => Promise.reject(new Error("computer is off"))) },
      computer,
      context,
      bot: { id: "bot-1", spaceId: "space-1" },
    });
    expect(left).toHaveLength(1);
  });
});

describe("closing a site's tabs on the computer", () => {
  it("asks the page browser to close the site's tabs", async () => {
    const liveDriver = vi.fn(async () => ({ ok: true, closed: 1 }));
    const provider = new ComputerBrowserProvider({ liveDriver });
    await expect(
      provider.closeSite(computer, { origin: "https://login.example.test" }, context),
    ).resolves.toEqual({ ok: true });
    expect(liveDriver).toHaveBeenCalledOnce();
    expect(liveDriver).toHaveBeenCalledWith(
      computer,
      { command: "close_site", origin: "https://login.example.test" },
      context,
    );
  });

  it("keeps the site on an older image that can't close tabs, without touching the page", async () => {
    const liveDriver = vi.fn(async () => ({
      ok: false,
      error: "unknown command: close_site",
      fallback: "computer_act" as const,
    }));
    const provider = new ComputerBrowserProvider({ liveDriver });
    await expect(
      provider.closeSite(computer, { origin: "https://login.example.test" }, context),
    ).resolves.toEqual({ ok: false });
    // No partial reset: a second tab or the history would still hold the page.
    expect(liveDriver).toHaveBeenCalledOnce();
  });

  it("keeps the site for a retry, without the fallback, after any other failure", async () => {
    const liveDriver = vi.fn(async () => ({
      ok: false,
      error: "Page browser timed out; the page may be busy",
      fallback: "computer_act" as const,
    }));
    const provider = new ComputerBrowserProvider({ liveDriver });
    await expect(
      provider.closeSite(computer, { origin: "https://login.example.test" }, context),
    ).resolves.toEqual({ ok: false });
    expect(liveDriver).toHaveBeenCalledOnce();
  });

  it("has nothing to close on a computer without a page browser", async () => {
    // Routed by the host to a computer with no page browser: no login was typed into a page.
    const routed = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        uncertain: false,
        fallback: "computer_act" as const,
        error: NO_PAGE_BROWSER_MESSAGE,
      }),
    });
    await expect(
      routed.closeSite(computer, { origin: "https://login.example.test" }, context),
    ).resolves.toEqual({ ok: true });
    // A sandbox with no page browser at all.
    const none = new ComputerBrowserProvider({ sandbox: {} as never });
    await expect(
      none.closeSite(computer, { origin: "https://login.example.test" }, context),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps the site when the computer's supervisor predates closing tabs", async () => {
    // An older supervisor turns down the command itself, which reaches here as a plain failure.
    const liveDriver = vi.fn(async () => ({
      ok: false,
      error: "page browser failed: 500",
      fallback: "computer_act" as const,
    }));
    const provider = new ComputerBrowserProvider({ liveDriver });
    await expect(
      provider.closeSite(computer, { origin: "https://login.example.test" }, context),
    ).resolves.toEqual({ ok: false });
    expect(liveDriver).toHaveBeenCalledOnce();
  });
});
