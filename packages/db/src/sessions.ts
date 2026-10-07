import type { PrismaClient } from "./client.js";

/**
 * Expiry of a session that may still receive a push. Missing and expired
 * sessions are ended, including when nothing has presented the expired row yet.
 */
export async function pushSessionExpiresAt(
  prisma: Pick<PrismaClient, "session">,
  sessionId: string,
): Promise<Date | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { expiresAt: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  return session.expiresAt;
}
