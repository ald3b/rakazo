import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { IsolationError } from "./scope.js";

describe("listSpaceGroupsForSpaces", () => {
  it("loads and maps compact cross-space group fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [{ blocks: [{ kind: "text", text: "Escalation pending" }] }],
        },
        members: [
          { bot: { id: "bot-1", name: "Triage", color: "#111", runs: [] } },
          {
            bot: {
              id: "bot-2",
              name: "Responder",
              color: "#222",
              runs: [{ status: "running" }],
            },
          },
        ],
      },
    ]);
    const repos = createGroupRepos({ chatGroup: { findMany } } as unknown as PrismaClient);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: false,
    };

    await expect(repos.listSpaceGroupsForSpaces(actor, ["workspace-2"])).resolves.toEqual([
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        members: [
          { botId: "bot-1", name: "Triage", color: "#111", status: "idle" },
          { botId: "bot-2", name: "Responder", color: "#222", status: "running" },
        ],
        preview: "Escalation pending",
        unread: true,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.select).not.toHaveProperty("userId");
    expect(query.select).not.toHaveProperty("archivedAt");
    expect(query.select).not.toHaveProperty("createdAt");
  });
});

describe("archiveGroup", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@example.com",
    isDeploymentOwner: true,
  };
  let queryRaw: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findManyRuns: ReturnType<typeof vi.fn>;
  let findManyComputers: ReturnType<typeof vi.fn>;
  let runUpdateMany: ReturnType<typeof vi.fn>;
  let attemptUpdateMany: ReturnType<typeof vi.fn>;
  let taskUpdateMany: ReturnType<typeof vi.fn>;
  let leaseUpdateMany: ReturnType<typeof vi.fn>;
  let leaseFindMany: ReturnType<typeof vi.fn>;
  let computerUpdateMany: ReturnType<typeof vi.fn>;
  let eventDeleteMany: ReturnType<typeof vi.fn>;
  let groupUpdate: ReturnType<typeof vi.fn>;
  let prisma: PrismaClient;

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }]);
    findFirst = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });
    findManyRuns = vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]);
    // As in production: acquisition writes the lease, never Computer.executionRunId.
    const computerRows = [
      {
        id: "computer-1",
        homeKey: "home-1",
        kind: "fake",
        providerRef: "computer-1",
        executionBotId: null,
        executionRunId: null,
      },
      {
        id: "computer-2",
        homeKey: "home-2",
        kind: "fake",
        providerRef: "computer-2",
        executionBotId: null,
        executionRunId: null,
      },
    ];
    type ComputerWhere = {
      id?: { in: string[] };
      executionRunId?: { in: string[] };
      OR?: ComputerWhere[];
    };
    const matches = (row: (typeof computerRows)[number], where: ComputerWhere): boolean =>
      (where.OR?.some((clause) => matches(row, clause)) ?? false) ||
      Boolean(where.id?.in.includes(row.id)) ||
      Boolean(row.executionRunId && where.executionRunId?.in.includes(row.executionRunId));
    findManyComputers = vi.fn(async ({ where }: { where: ComputerWhere }) =>
      computerRows.filter((row) => matches(row, where)),
    );
    runUpdateMany = vi.fn();
    attemptUpdateMany = vi.fn();
    taskUpdateMany = vi.fn();
    leaseUpdateMany = vi.fn();
    // computer-1 is a Team computer: bot-2's lease there belongs to a run outside this group.
    const leaseRows = [
      { computerId: "computer-1", botId: "bot-1", runId: "run-1", fence: 3 },
      { computerId: "computer-1", botId: "bot-2", runId: "run-other", fence: 7 },
      { computerId: "computer-2", botId: "bot-3", runId: "run-other-group", fence: 1 },
    ];
    leaseFindMany = vi.fn(async ({ where }: { where: { runId: { in: string[] } } }) =>
      leaseRows.filter((lease) => where.runId.in.includes(lease.runId)),
    );
    computerUpdateMany = vi.fn();
    eventDeleteMany = vi.fn();
    groupUpdate = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      chatGroup: { findFirst, update: groupUpdate },
      run: { findMany: findManyRuns, updateMany: runUpdateMany },
      attempt: { updateMany: attemptUpdateMany },
      task: { updateMany: taskUpdateMany },
      computerExecutionLease: { findMany: leaseFindMany, updateMany: leaseUpdateMany },
      computer: { findMany: findManyComputers, updateMany: computerUpdateMany },
      event: { deleteMany: eventDeleteMany },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
  });

  it("tears down only this thread's runs, each under its own lease", async () => {
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).resolves.toEqual({
      cancelledRunIds: ["run-1"],
      computers: [
        {
          id: "computer-1",
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          botId: "bot-1",
          runId: "run-1",
          fence: 3,
        },
      ],
    });

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "group-1",
          archivedAt: null,
        }),
      }),
    );
    // The leases outlive the transaction so the caller's screen release still carries the fence.
    expect(leaseUpdateMany).not.toHaveBeenCalled();
    expect(computerUpdateMany).not.toHaveBeenCalled();
    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: expect.objectContaining({ pinned: false, archivedAt: expect.any(Date) }),
    });
  });

  it("expires the archived runs' leases and legacy columns once teardown is done", async () => {
    const expire = vi.fn();
    const clear = vi.fn();
    const repos = createGroupRepos({
      computerExecutionLease: { updateMany: expire },
      computer: { updateMany: clear },
    } as unknown as PrismaClient);

    await repos.releaseArchivedRunLeases([]);
    expect(expire).not.toHaveBeenCalled();
    await repos.releaseArchivedRunLeases(["run-1"]);
    expect(expire).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(clear).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
  });

  it("rejects when the group is already archived or missing", async () => {
    findFirst.mockResolvedValue(null);
    const repos = createGroupRepos(prisma);
    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });
});
