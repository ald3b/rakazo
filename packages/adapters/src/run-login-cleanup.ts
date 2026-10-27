import type { AdapterContext, BrowserProvider, ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * What a computer tool gets while a site from an ended login is still open in the browser. A
 * computer whose supervisor predates closing tabs keeps getting it until it is updated.
 */
export const ENDED_LOGIN_CLEANUP_PENDING =
  "The computer's browser is still closing a page from an earlier sign-in. Try again in a moment; if this keeps happening, the computer needs updating.";

/**
 * Close the bot's tabs on each site whose run login ended after being typed on this computer, then
 * drop those logins' rows. The site's cookies stay, so the bot may stay signed in; only the login
 * itself is gone. A site that can't be cleaned now keeps its rows, and no computer tool of the bot
 * runs here until it is. A login typed on another computer is left for that computer's cleanup,
 * since closing tabs here doesn't close them there. Returns whether every such site is now closed.
 */
export async function cleanUpEndedRunLogins(input: {
  prisma: PrismaClient;
  browser: Pick<BrowserProvider, "closeSite">;
  computer: ComputerRef;
  /** The stored computer `computer` runs, which logins record when they are typed. */
  computerId: string;
  context: AdapterContext;
  bot: { id: string; spaceId: string };
}): Promise<boolean> {
  const ended = await input.prisma.runLogin.findMany({
    where: {
      botId: input.bot.id,
      spaceId: input.bot.spaceId,
      endedAt: { not: null },
      filledComputerId: input.computerId,
    },
    select: { id: true, origin: true },
  });
  const sites = new Map<string, string[]>();
  for (const row of ended) sites.set(row.origin, [...(sites.get(row.origin) ?? []), row.id]);
  let allCleaned = true;
  for (const [origin, ids] of sites) {
    let cleaned: boolean;
    try {
      cleaned = input.browser.closeSite
        ? (await input.browser.closeSite(input.computer, { origin }, input.context)).ok
        : true;
    } catch {
      cleaned = false;
    }
    if (!cleaned) {
      // Never the site or the login: the rows say which, for an operator who needs to know.
      getLogger().warn("ended run login cleanup will be retried", { botId: input.bot.id });
      allCleaned = false;
      continue;
    }
    await input.prisma.runLogin.deleteMany({ where: { id: { in: ids }, endedAt: { not: null } } });
  }
  return allCleaned;
}

/**
 * Whether a run login is typed on this computer while its run is still going. Its page may still
 * hold the password, which only that run hides from what it reads, so a check that isn't that
 * run waits instead of reading the computer.
 */
export async function liveRunLoginOn(
  prisma: Pick<PrismaClient, "runLogin">,
  computerId: string,
): Promise<boolean> {
  const live = await prisma.runLogin.count({
    where: { filledComputerId: computerId, filledAt: { not: null }, endedAt: null },
  });
  return live > 0;
}
