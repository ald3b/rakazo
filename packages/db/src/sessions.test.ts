import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { pushSessionExpiresAt } from "./sessions.js";

describe("pushSessionExpiresAt", () => {
  it("returns null when the session is missing or expired", async () => {
    let row: { expiresAt: Date } | null = null;
    const prisma = {
      session: { findUnique: vi.fn(async () => row) },
    } as unknown as Pick<PrismaClient, "session">;

    await expect(pushSessionExpiresAt(prisma, "session-1")).resolves.toBeNull();

    row = { expiresAt: new Date(Date.now() - 1_000) };
    await expect(pushSessionExpiresAt(prisma, "session-1")).resolves.toBeNull();

    const expiresAt = new Date(Date.now() + 60_000);
    row = { expiresAt };
    await expect(pushSessionExpiresAt(prisma, "session-1")).resolves.toBe(expiresAt);
  });
});
