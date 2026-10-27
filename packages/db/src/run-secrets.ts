import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { clearRunTurnCheckpoints } from "./run-turn-checkpoint.js";

/** A secret card's answer waits under this kind until the resumed run reads it once. */
export function runSecretKind(runId: string): string {
  return `run-secret:${runId}`;
}

/**
 * An ended run never reads its waiting answer, so drop it with the run. The answer is stored
 * under the run's user and space, which also keeps this delete on the secrets index. The run's
 * unremembered logins end with it too.
 */
export async function deleteRunSecretsInTransaction(
  tx: Pick<Prisma.TransactionClient, "secret" | "runLogin">,
  runs: ReadonlyArray<{ id: string; userId: string; spaceId: string }>,
): Promise<void> {
  if (runs.length === 0) return;
  await tx.secret.deleteMany({
    where: {
      OR: runs.map((run) => ({
        userId: run.userId,
        spaceId: run.spaceId,
        kind: runSecretKind(run.id),
      })),
    },
  });
  await endRunLoginsInTransaction(
    tx,
    runs.map((run) => run.id),
  );
}

/**
 * End runs' unremembered logins. One that was never filled is simply deleted. A filled one has
 * its value wiped now and keeps its row, without it, until the bot's browser has been cleaned up
 * for its site.
 */
export async function endRunLoginsInTransaction(
  tx: Pick<Prisma.TransactionClient, "runLogin">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) return;
  await endRunLogins(tx, { runId: { in: [...runIds] } });
}

async function endRunLogins(
  tx: Pick<Prisma.TransactionClient, "runLogin">,
  where: Prisma.RunLoginWhereInput,
): Promise<void> {
  await tx.runLogin.deleteMany({ where: { ...where, endedAt: null, filledAt: null } });
  await tx.runLogin.updateMany({
    where: { ...where, endedAt: null },
    data: { ciphertext: "", endedAt: new Date() },
  });
}

/** End a run's unremembered login under `name`, as its run ending would. */
export async function endRunLoginsByName(
  tx: Pick<Prisma.TransactionClient, "runLogin">,
  runId: string,
  name: string,
): Promise<void> {
  await endRunLogins(tx, { runId, name });
}

/**
 * A run's continuation takes over the unremembered logins of its own person: the same sign-in
 * goes on there. Another member's login stays with the run, to end with it.
 */
export async function moveRunLoginsInTransaction(
  tx: Pick<Prisma.TransactionClient, "runLogin" | "run">,
  fromRunId: string,
  toRunId: string,
): Promise<void> {
  const { userId } = await tx.run.findUniqueOrThrow({
    where: { id: toRunId },
    select: { userId: true },
  });
  await tx.runLogin.updateMany({
    where: { runId: fromRunId, userId, endedAt: null },
    data: { runId: toRunId },
  });
}

/**
 * Clear what cancelled runs kept for resuming: the turn checkpoint, any waiting one-time
 * answer, and open approval effects, which a dead run can no longer settle. Paths that cancel
 * by id read each run's user and space here for the secrets index.
 */
export async function clearEndedRunState(
  prisma: Pick<PrismaClient, "run" | "externalEffect" | "secret" | "message" | "runLogin">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) return;
  await clearRunTurnCheckpoints(prisma, runIds);
  // Only effects behind an unanswered card: a tool that needs no approval also runs as intended.
  const messages = await prisma.message.findMany({
    where: { runId: { in: [...runIds] }, role: "bot" },
    select: { blocks: true },
  });
  const openCards = messages.flatMap(({ blocks }) =>
    (MessageBlockSchema.array().safeParse(blocks).data ?? []).flatMap((block) =>
      block.kind === "ask" && block.status !== "answered" && block.approvalEffectId
        ? [block.approvalEffectId]
        : [],
    ),
  );
  if (openCards.length > 0) {
    await prisma.externalEffect.updateMany({
      where: { id: { in: openCards }, runId: { in: [...runIds] }, status: "intended" },
      data: { status: "denied" },
    });
  }
  const runs = await prisma.run.findMany({
    where: { id: { in: [...runIds] } },
    select: { id: true, userId: true, spaceId: true },
  });
  await deleteRunSecretsInTransaction(prisma, runs);
}
