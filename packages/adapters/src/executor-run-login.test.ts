import type { ComputerRef } from "@rakazo/adapter-kit";
import { encodeLoginSecret } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_LOGIN_NAME_TAKEN } from "./bot-secrets.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { EncryptedSecretStore } from "./secrets.js";

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer: async () => COMPUTER,
}));

type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
) => Promise<unknown>;

/** Every database call, by model and method, so a test can check what was written anywhere. */
function recordingPrisma(models: Record<string, Record<string, unknown>>, calls: unknown[]) {
  const fallback: Record<string, (...args: unknown[]) => unknown> = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => unknown) => fn(prisma);
        }
        // The member's settings lock always finds the membership row.
        if (model === "$queryRaw") return async () => [{ locked: 1 }];
        const methods = models[model] ?? {};
        return new Proxy(methods, {
          get: (target, method: string) => {
            const impl = (target[method] ?? fallback[method]) as
              | ((...args: unknown[]) => unknown)
              | undefined;
            return async (...args: unknown[]) => {
              calls.push([model, method, args]);
              return impl ? impl(...args) : null;
            };
          },
        });
      },
    },
  );
  return prisma;
}

const ORIGIN = "https://login.example.test";
const DESTINATION = { name: "site_login", origin: ORIGIN, auth: { type: "login" } };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };

async function runLogin(runId: string) {
  const stored = await secretStore.put(
    encodeLoginSecret({ username: "fake-user", password: "fake-password-1" }),
    { ...scope, operationId: runId, traceId: runId, signal: new AbortController().signal },
    { ephemeral: true },
  );
  return {
    ...stored,
    ...scope,
    runId,
    name: "site_login",
    origin: ORIGIN,
    filledComputerId: "computer-1",
    endedAt: null,
  };
}

/**
 * One run of the bot calling one tool, with an optional effect that the person already answered
 * (the request_secret card) and the given run logins.
 */
async function runTool(
  call: { name: string; args: Record<string, unknown> },
  options: {
    answered?: Record<string, unknown>;
    runLogins?: Array<Record<string, unknown>>;
    browser?: Record<string, unknown>;
    onExecute?: () => void;
  } = {},
) {
  const run = {
    id: "run-1",
    botId: scope.botId,
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: scope.spaceId,
    userId: scope.userId,
    status: "queued",
    trigger: "message",
    routineId: null,
    retryOfRunId: null,
    leaseFence: 0,
  };
  const calls: unknown[] = [];
  const toolResults: unknown[] = [];
  const runtimeRun = vi.fn(async function* (request: { executeTool?: ExecuteTool }) {
    toolResults.push(
      await request
        .executeTool?.(call.name, call.args, "exec-1")
        .catch((error: unknown) => ({ thrown: (error as Error).message })),
    );
    yield { type: "done" as const, text: "" };
  });
  const runLogins = options.runLogins ?? [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "not" in value
        ? row[key] !== (value as { not: unknown }).not
        : row[key] === value,
    );
  const prisma = recordingPrisma(
    {
      run: {
        findUnique: async () => run,
        findUniqueOrThrow: async () => run,
        findFirst: async () => ({ bot: { notifyOnFinish: false }, thread: { groupId: null } }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        },
      },
      bot: {
        findUniqueOrThrow: async () => ({
          id: run.botId,
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated", kind: "e2b", homeKey: "home-1" },
        }),
        findMany: async () => [],
      },
      attempt: {
        create: async () => ({ id: "attempt-1" }),
        updateMany: async () => ({ count: 1 }),
      },
      thread: {
        findUniqueOrThrow: async () => ({
          id: run.threadId,
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 1,
        }),
      },
      task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Sign in to the site" }) },
      computer: { updateMany: async () => ({ count: 1 }) },
      deploymentSettings: {
        findUnique: async () => ({
          defaultModelProvider: "local",
          defaultModelId: "local-model",
        }),
      },
      runLogin: {
        deleteMany: async ({ where }: { where: { id?: { in: string[] } } }) => {
          const before = runLogins.length;
          for (const id of where.id?.in ?? [])
            runLogins.splice(
              runLogins.findIndex((row) => row.id === id),
              1,
            );
          return { count: before - runLogins.length };
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          runLogins.find((row) => matches(row, where)) ?? null,
        findMany: async ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select: Record<string, true>;
        }) =>
          runLogins
            .filter((row) => matches(row, where))
            .map((row) => Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))),
      },
      // These runs act without approval cards; the card flow has its own tests.
      actionAutoReviewPreference: {
        findUnique: async () => ({ enabled: false, skipApprovals: true }),
      },
      userActionAutoReviewPreference: {
        findUnique: async () => ({ enabled: false, skipApprovals: true }),
      },
      externalEffect: {
        findUnique: async () =>
          options.answered
            ? {
                id: "effect-1",
                runId: run.id,
                spaceId: run.spaceId,
                kind: call.name,
                status: "approved",
                request: call.args,
                ...options.answered,
              }
            : null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: `effect-${data.idempotencyKey}`,
          ...data,
        }),
        updateMany: async () => ({ count: 1 }),
      },
    },
    calls,
  );
  const events = {
    append: vi.fn(async () => undefined),
    finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    pauseRunForTakeover: vi.fn(async () => false),
    pauseRunForInput: vi.fn(async () => true),
  };
  const executor = createRunExecutor({
    prisma,
    deploymentModelKey: "fake-deployment-key",
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ id: "e2b", capabilities: { graphical: true } }),
      releaseScreen: vi.fn(async () => undefined),
      execute: vi.fn(async function* () {
        options.onExecute?.();
        yield { type: "exit" as const, code: 0 };
      }),
      async *exportWorkspace() {
        yield* [];
      },
    },
    secretStore,
    ...(options.browser ? { browser: options.browser } : {}),
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    artifacts: { get: vi.fn() },
    events,
    jobs: { enqueue: vi.fn(async () => undefined) },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  return { toolResults, calls };
}

const requestLogin = (extra: Record<string, unknown> = {}) => ({
  name: "request_secret",
  args: { label: "Sign in", purpose: "password", credential: DESTINATION, ...extra },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request_secret for a website login", () => {
  it("tells the bot a login answered without Remember is kept for this run only", async () => {
    const { toolResults, calls } = await runTool(requestLogin(), {
      answered: { result: { credentialSaved: DESTINATION, remembered: false } },
      runLogins: [await runLogin("run-1")],
    });
    expect(toolResults).toEqual([{ saved: true, ...DESTINATION, remembered: false }]);
    expect(JSON.stringify(calls)).not.toContain("fake-password-1");
  });

  it("opens the card again in a later run, since the login went with its run", async () => {
    const { toolResults } = await runTool(requestLogin(), {
      runLogins: [await runLogin("run-0")],
    });
    expect(toolResults).toMatchObject([{ details: { secret: "paused" } }]);
  });

  it("can't be told by the bot to remember the login", async () => {
    const { calls } = await runTool(requestLogin({ remember: true, persist: true, save: true }));
    // The card opens as usual; what is kept is decided only by the person's answer.
    expect(JSON.stringify(calls)).toContain('"kind":"request_secret"');
    expect(JSON.stringify(calls)).not.toContain('"vaultCredential","create"');
    expect(JSON.stringify(calls)).not.toContain('"vaultCredential","update"');
  });
});

describe("list_secrets", () => {
  it("shows this run's unremembered login and not another run's", async () => {
    const { toolResults } = await runTool(
      { name: "list_secrets", args: {} },
      { runLogins: [await runLogin("run-1"), await runLogin("run-2")] },
    );
    expect(toolResults).toEqual([
      [{ name: "site_login", origin: ORIGIN, auth: { type: "login" }, remembered: false }],
    ]);
  });
});

describe("generate_secret", () => {
  it("won't save a login under the name of this run's own login, which fills would skip", async () => {
    const { toolResults, calls } = await runTool(
      { name: "generate_secret", args: { name: "site_login", type: "login", origin: ORIGIN } },
      { runLogins: [await runLogin("run-1")] },
    );
    expect(toolResults).toEqual([{ error: RUN_LOGIN_NAME_TAKEN }]);
    expect(JSON.stringify(calls)).not.toContain('"vaultCredential","create"');
  });
});

describe("forget_secret", () => {
  it("also removes this run's unremembered login under the name", async () => {
    const { toolResults, calls } = await runTool({
      name: "forget_secret",
      args: { name: "site_login" },
    });
    expect(toolResults).toEqual([{ removed: true }]);
    expect(calls).toContainEqual([
      "runLogin",
      "updateMany",
      [
        {
          where: {
            runId: "run-1",
            spaceId: "space-1",
            userId: "user-1",
            name: "site_login",
            endedAt: null,
          },
          data: { ciphertext: "", endedAt: expect.any(Date) },
        },
      ],
    ]);
  });
});

describe("a run after a login ended", () => {
  it("closes the ended login's site before its first computer tool runs", async () => {
    const order: string[] = [];
    const browser = {
      describe: () => ({ id: "fake", capabilities: {} }),
      closeSite: vi.fn(async () => {
        order.push("closeSite");
        return { ok: true };
      }),
      snapshot: vi.fn(),
      navigate: vi.fn(),
      act: vi.fn(),
    };
    const ended = { ...(await runLogin("run-0")), ciphertext: "", endedAt: new Date() };
    const { calls } = await runTool(
      { name: "shell", args: { command: "true" } },
      { runLogins: [ended], browser, onExecute: () => order.push("shell") },
    );
    expect(order).toEqual(["closeSite", "shell"]);
    expect(browser.closeSite).toHaveBeenCalledWith(
      expect.anything(),
      { origin: ORIGIN },
      expect.anything(),
    );
    expect(calls).toContainEqual([
      "runLogin",
      "deleteMany",
      [{ where: { id: { in: [ended.id] }, endedAt: { not: null } } }],
    ]);
  });
});

describe("a run on another computer than the one its ended login was typed on", () => {
  it("leaves that login's site for its own computer to close", async () => {
    const onExecute = vi.fn();
    const browser = {
      describe: () => ({ id: "fake", capabilities: {} }),
      closeSite: vi.fn(async () => ({ ok: true })),
      snapshot: vi.fn(),
      navigate: vi.fn(),
      act: vi.fn(),
    };
    const ended = {
      ...(await runLogin("run-0")),
      ciphertext: "",
      filledComputerId: "computer-2",
      endedAt: new Date(),
    };
    const runLogins = [ended];
    await runTool({ name: "shell", args: { command: "true" } }, { runLogins, browser, onExecute });
    expect(onExecute).toHaveBeenCalledOnce();
    expect(browser.closeSite).not.toHaveBeenCalled();
    expect(runLogins).toEqual([ended]);
  });
});

describe("a computer without a page browser", () => {
  it("doesn't hold a later run's tools for a login no page could have been given", async () => {
    const onExecute = vi.fn();
    const ended = { ...(await runLogin("run-0")), ciphertext: "", endedAt: new Date() };
    // The default browser provider, on a sandbox with no page browser at all.
    await runTool({ name: "shell", args: { command: "true" } }, { runLogins: [ended], onExecute });
    expect(onExecute).toHaveBeenCalledOnce();
  });
});

describe("a run whose ended login's site can't be closed yet", () => {
  it("keeps the bot's computer tools waiting instead of letting them read the page", async () => {
    const onExecute = vi.fn();
    const browser = {
      describe: () => ({ id: "fake", capabilities: {} }),
      closeSite: vi.fn(async () => ({ ok: false })),
      snapshot: vi.fn(),
      navigate: vi.fn(),
      act: vi.fn(),
    };
    const ended = { ...(await runLogin("run-0")), ciphertext: "", endedAt: new Date() };
    const { toolResults } = await runTool(
      { name: "shell", args: { command: "cat page.html" } },
      { runLogins: [ended], browser, onExecute },
    );
    expect(onExecute).not.toHaveBeenCalled();
    expect(JSON.stringify(toolResults)).toContain("still closing a page from an earlier sign-in");
    expect(JSON.stringify(toolResults)).toContain("the computer needs updating");
  });
});
