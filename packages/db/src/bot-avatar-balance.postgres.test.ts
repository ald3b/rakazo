import { BOT_COLORS } from "@rakazo/contracts";
import { organicAvatarFamily, organicAvatarLook } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("new bot avatars (PostgreSQL)", () => {
  const provider = "sendblue";
  // A prefix no other test file uses, so parallel files never share this account.
  const address = `+1554${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: { userId: string; spaceId: string };

  const actor = () => ({
    userId: owner.userId,
    spaceId: owner.spaceId,
    email: "avatars@example.com",
    isDeploymentOwner: false,
  });
  const botInput = (name: string) => ({
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });

  afterAll(async () => {
    if (prisma && owner) {
      const system = asSystem(prisma, "test fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      await system.organization.deleteMany({ where: { id: owner.spaceId } });
      await system.user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });

  it("gives each new bot a shape and colour the user's other bots use least", async () => {
    const repos = createRepos(prisma);
    const system = asSystem(prisma);
    const before = await system.bot.findMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
      select: { id: true, color: true },
    });

    const created = await runAsTenant(owner, async () => {
      const bots = [];
      for (let index = 0; index < 9; index++) {
        bots.push(await repos.createBot(actor(), botInput(`Helper ${index}`)));
      }
      // A bot made by a bot goes through the same choice.
      bots.push(await repos.createBot(actor(), { ...botInput("Child"), parentBotId: bots[0]!.id }));
      return bots;
    });

    const all = [...before, ...created];
    const lookOf = (id: string) => organicAvatarLook(organicAvatarFamily(id));
    // Nine looks: the first nine bots never repeat one.
    const firstNine = all.slice(0, 9);
    expect(new Set(firstNine.map((bot) => lookOf(bot.id))).size).toBe(firstNine.length);
    // The starter bot counts too: the first seven bots share no colour.
    const firstColors = all.slice(0, BOT_COLORS.length).map((bot) => bot.color);
    expect(new Set(firstColors).size).toBe(firstColors.length);
    expect(created.every((bot) => /^c[a-z0-9]{24}$/.test(bot.id))).toBe(true);

    // Existing bots keep their id and colour.
    const after = await system.bot.findMany({
      where: { id: { in: before.map((bot) => bot.id) } },
      select: { id: true, color: true },
    });
    expect(after).toEqual(expect.arrayContaining(before));
  });

  it("keeps a colour the caller chose and skips archived bots", async () => {
    const repos = createRepos(prisma);
    const system = asSystem(prisma);
    const live = await system.bot.findMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
      select: { id: true },
    });
    // Archive every bot but one; the next bot then avoids only that one's family.
    const [kept, ...rest] = live;
    await system.bot.updateMany({
      where: { id: { in: rest.map((bot) => bot.id) } },
      data: { archivedAt: new Date() },
    });
    const next = await runAsTenant(owner, () =>
      repos.createBot(actor(), { ...botInput("Picked"), color: "#123456" }),
    );
    expect(next.color).toBe("#123456");
    expect(organicAvatarLook(organicAvatarFamily(next.id))).not.toBe(
      organicAvatarLook(organicAvatarFamily(kept!.id)),
    );
  });
});
