import { decodeLoginSecret, encodeLoginSecret } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { deleteRunSecretsInTransaction, moveRunLoginsInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  forgetRunLogin,
  listRunLogins,
  loadRunLoginRedactions,
  RUN_LOGIN_ON_ANOTHER_COMPUTER,
  resolveLoginFill,
} from "./bot-secrets.js";
import { createRunSecretWriter } from "./run-secret.js";
import { EncryptedSecretStore } from "./secrets.js";

type Row = Record<string, unknown>;

const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const ORIGIN = "https://login.example.test";
const secretStore = new EncryptedSecretStore("test-only-encryption-key");

/** An in-memory table set with the filters these paths use. */
function database(tables: Record<string, Row[]> = {}) {
  const data = new Map<string, Row[]>(
    ["secret", "botSecret", "integrationProviderConfig", "run", "message", "runLogin"].map(
      (name) => [name, tables[name] ?? []],
    ),
  );
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "OR") return (value as Row[]).some((branch) => matches(row, branch));
      const actual = row[key];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const filter = value as Row;
        if ("in" in filter) return (filter.in as unknown[]).includes(actual);
      }
      return actual === value || (value === null && actual === undefined);
    });
  const client: Record<string, unknown> = {};
  for (const [name, rows] of data) {
    client[name] = {
      findFirst: async ({ where }: { where?: Row } = {}) =>
        rows.find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where }: { where?: Row } = {}) =>
        rows.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where, select }: { where?: Row; select?: Row } = {}) =>
        rows
          .filter((row) => matches(row, where))
          .map((row) =>
            select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row,
          ),
      count: async ({ where }: { where?: Row } = {}) =>
        rows.filter((row) => matches(row, where)).length,
      create: async ({ data: row }: { data: Row }) => {
        rows.push({ ...row });
        return row;
      },
      updateMany: async ({ where, data: change }: { where?: Row; data: Row }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, change);
        return { count: hit.length };
      },
      delete: async ({ where }: { where: Row }) => {
        const index = rows.findIndex((row) => matches(row, where));
        return rows.splice(index, 1)[0];
      },
      deleteMany: async ({ where }: { where?: Row } = {}) => {
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matches(rows[index]!, where)) rows.splice(index, 1);
        }
        return { count: before - rows.length };
      },
    };
  }
  client.$transaction = async (fn: (tx: unknown) => unknown) => fn(client);
  client.$queryRaw = async () => [];
  return { prisma: client as unknown as PrismaClient, data };
}

const loginAsk = {
  kind: "ask",
  text: "Sign in",
  input: "secret",
  purpose: "password",
  status: "pending",
  credential: { name: "site_login", origin: ORIGIN, auth: { type: "login" } },
};

async function answerLoginCard(
  remember: boolean,
  tables: Record<string, Row[]> = {},
  ask: typeof loginAsk = loginAsk,
) {
  const db = database({
    run: [{ id: "run-1", ...scope, threadId: "thread-1", status: "waiting_input" }],
    message: [
      { id: "message-1", threadId: "thread-1", runId: "run-1", role: "bot", blocks: [ask] },
    ],
    ...tables,
  });
  const writer = createRunSecretWriter(secretStore);
  const input = {
    spaceId: scope.spaceId,
    threadId: "thread-1",
    runId: "run-1",
    messageId: "message-1",
    answeredByUserId: scope.userId,
    username: "fake-user@example.test",
    answer: "fake-password-1",
    ...(remember ? { remember } : {}),
  };
  await writer.withPrepared!(db.prisma, input, (prepared) =>
    prepared.store({
      botId: scope.botId,
      credential: ask.credential as never,
      remember,
      runId: "run-1",
      userId: scope.userId,
      spaceId: scope.spaceId,
      plaintext: encodeLoginSecret({ username: input.username, password: input.answer }),
      tx: db.prisma as never,
    }),
  );
  return db;
}

async function runLogin(
  runId: string,
  name = "site_login",
  origin = ORIGIN,
  password = `password-${runId}`,
) {
  const stored = await secretStore.put(
    encodeLoginSecret({ username: `user-${runId}`, password }),
    { ...scope, operationId: runId, traceId: runId, signal: new AbortController().signal },
    { ephemeral: true },
  );
  // Filled unless a test says otherwise: an unfilled one leaves nothing in the browser.
  return {
    ...stored,
    ...scope,
    runId,
    name,
    origin,
    filledAt: new Date(0),
    filledComputerId: "computer-1",
    endedAt: null,
  };
}

describe("a login answered without Remember for next time", () => {
  it("is kept for the run that asked, bound to the card's site, and saves nothing", async () => {
    const db = await answerLoginCard(false);
    expect(db.data.get("botSecret")).toEqual([]);
    expect(db.data.get("secret")).toEqual([]);
    const rows = db.data.get("runLogin")!;
    expect(rows).toMatchObject([{ ...scope, runId: "run-1", name: "site_login", origin: ORIGIN }]);
    expect(rows[0]!.ciphertext).not.toContain("fake-password-1");
    expect(
      decodeLoginSecret(
        await secretStore.load(rows[0]!.ciphertext as string, rows[0]!.id as string),
      ),
    ).toEqual({ username: "fake-user@example.test", password: "fake-password-1" });
  });

  it("never touches a saved login of the same name", async () => {
    const saved = {
      id: "saved-1",
      ...scope,
      name: "site_login",
      origin: ORIGIN,
      auth: { type: "login" },
      ciphertext: "saved-ciphertext",
      updatedAt: new Date(0),
    };
    const db = await answerLoginCard(false, { botSecret: [{ ...saved }] });
    expect(db.data.get("botSecret")).toEqual([saved]);
    expect(db.data.get("runLogin")).toHaveLength(1);
    await deleteRunSecretsInTransaction(db.prisma, [{ id: "run-1", ...scope }]);
    expect(db.data.get("botSecret")).toEqual([saved]);
  });

  it("takes the place of this run's earlier answer to the same card", async () => {
    const earlier = { ...(await runLogin("run-1")), filledAt: null };
    const db = await answerLoginCard(false, { runLogin: [earlier] });
    const rows = db.data.get("runLogin")!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(earlier.id);
    expect(rows[0]!.filledAt ?? null).toBeNull();
  });

  it("ends an earlier answer the page browser typed now, so its site is cleaned up", async () => {
    const earlier = await runLogin("run-1");
    const db = await answerLoginCard(false, { runLogin: [earlier] });
    // Its password is no longer hidden from the resumed run, so its tabs must close first.
    expect(db.data.get("runLogin")).toEqual([
      expect.objectContaining({ id: earlier.id, ciphertext: "", endedAt: expect.any(Date) }),
      expect.objectContaining({ origin: ORIGIN }),
    ]);
    expect(db.data.get("runLogin")![1]!.filledAt ?? null).toBeNull();
  });

  it("ends a typed earlier answer for another site now, so that site is cleaned up", async () => {
    const earlier = await runLogin("run-1", "site_login", "https://old-login.example.test");
    const db = await answerLoginCard(false, { runLogin: [earlier] });
    expect(db.data.get("runLogin")).toEqual([
      expect.objectContaining({
        id: earlier.id,
        origin: "https://old-login.example.test",
        ciphertext: "",
        endedAt: expect.any(Date),
      }),
      expect.objectContaining({ origin: ORIGIN }),
    ]);
    // Only the new answer is filled from now on.
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        prisma: db.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "site_login",
        field: "password",
      }),
    ).toMatchObject({ text: "fake-password-1", origin: ORIGIN });
  });

  it("is filled before a saved login of the same name, by its own run only", async () => {
    const db = database({ runLogin: [await runLogin("run-1")] });
    const input = { prisma: db.prisma, secretStore, scope, name: "site_login" };
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        ...input,
        runId: "run-1",
        field: "password",
      }),
    ).toEqual({
      text: "password-run-1",
      origin: ORIGIN,
      redactions: expect.arrayContaining(["password-run-1"]),
    });
    // A concurrent run of the same bot never sees it.
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        ...input,
        runId: "run-2",
        field: "password",
      }),
    ).toEqual({
      error: "Login is unavailable. Use request_secret to save it first.",
    });
    const http = database({ runLogin: [await runLogin("run-1", "site_login", "http://a.test")] });
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        ...input,
        prisma: http.prisma,
        runId: "run-1",
        field: "password",
      }),
    ).toEqual({ error: "Website logins can only be filled on an HTTPS origin." });
  });

  it("is listed and redacted for its own run only", async () => {
    const db = database({
      runLogin: [await runLogin("run-1"), await runLogin("run-2", "other_login")],
    });
    expect(await listRunLogins(db.prisma, scope, "run-1")).toEqual([
      { name: "site_login", origin: ORIGIN, auth: { type: "login" }, remembered: false },
    ]);
    const redactions = await loadRunLoginRedactions(db.prisma, secretStore, scope, "run-1");
    expect(redactions).toContain("password-run-1");
    expect(redactions).not.toContain("password-run-2");
  });
});

describe("hiding a run login from its run's output", () => {
  it("uses the same forms as a saved login: plain, URL-encoded, form-encoded and base64", async () => {
    const password = "fake pass!word";
    const db = database({ runLogin: [await runLogin("run-1", "site_login", ORIGIN, password)] });
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({ v: password }).toString().slice(2),
      Buffer.from(password).toString("base64"),
    ];
    const loaded = await loadRunLoginRedactions(db.prisma, secretStore, scope, "run-1");
    const filled = await resolveLoginFill({
      computerId: "computer-1",
      prisma: db.prisma,
      secretStore,
      scope,
      runId: "run-1",
      name: "site_login",
      field: "password",
    });
    for (const form of forms) {
      expect(loaded).toContain(form);
      expect("redactions" in filled && filled.redactions).toContain(form);
    }
  });

  it("hides a short password only as it is and URL-encoded", async () => {
    const db = database({ runLogin: [await runLogin("run-1", "site_login", ORIGIN, "ab c")] });
    expect(await loadRunLoginRedactions(db.prisma, secretStore, scope, "run-1")).toEqual(
      expect.arrayContaining(["ab c", "ab%20c"]),
    );
    expect(await loadRunLoginRedactions(db.prisma, secretStore, scope, "run-1")).not.toContain(
      Buffer.from("ab c").toString("base64"),
    );
  });
});

describe("a login answered with Remember for next time", () => {
  it("is saved as a credential and keeps nothing for the run", async () => {
    const db = await answerLoginCard(true);
    expect(db.data.get("runLogin")).toEqual([]);
    expect(db.data.get("botSecret")).toMatchObject([
      { ...scope, name: "site_login", origin: ORIGIN },
    ]);
  });
});

describe("a login remembered after this run kept one under the same name", () => {
  it("ends the run's login, so fills use the remembered one", async () => {
    const db = await answerLoginCard(true, { runLogin: [await runLogin("run-1")] });
    expect(db.data.get("runLogin")).toMatchObject([{ ciphertext: "", endedAt: expect.any(Date) }]);
    expect(db.data.get("botSecret")).toHaveLength(1);
  });

  it("keeps that ended login for cleanup when the card is answered again unremembered", async () => {
    const ended = { ...(await runLogin("run-1")), ciphertext: "", endedAt: new Date(1) };
    const db = await answerLoginCard(false, { runLogin: [ended] });
    expect(db.data.get("runLogin")).toEqual([ended, expect.objectContaining({ origin: ORIGIN })]);
  });
});

describe("when a login's run ends", () => {
  it("wipes the value and keeps a tombstone for the browser cleanup, for that run only", async () => {
    const db = database({ runLogin: [await runLogin("run-1"), await runLogin("run-2")] });
    await deleteRunSecretsInTransaction(db.prisma, [{ id: "run-1", ...scope }]);
    const [ended, other] = db.data.get("runLogin")!;
    expect(ended).toMatchObject({ runId: "run-1", ciphertext: "", endedAt: expect.any(Date) });
    expect(other).toMatchObject({ runId: "run-2", endedAt: null });
    expect(other!.ciphertext).not.toBe("");
    expect(await listRunLogins(db.prisma, scope, "run-1")).toEqual([]);
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        prisma: db.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "site_login",
        field: "password",
      }),
    ).toMatchObject({ error: expect.any(String) });
  });

  it("is deleted outright if it was never filled, since the browser never had it", async () => {
    const db = database({
      runLogin: [
        { ...(await runLogin("run-1")), filledAt: null },
        await runLogin("run-1", "other"),
      ],
    });
    await deleteRunSecretsInTransaction(db.prisma, [{ id: "run-1", ...scope }]);
    expect(db.data.get("runLogin")).toMatchObject([
      { name: "other", ciphertext: "", endedAt: expect.any(Date) },
    ]);
  });

  it("is marked filled when it is handed to the page browser", async () => {
    const db = database({ runLogin: [{ ...(await runLogin("run-1")), filledAt: null }] });
    await resolveLoginFill({
      computerId: "computer-1",
      prisma: db.prisma,
      secretStore,
      scope,
      runId: "run-1",
      name: "site_login",
      field: "username",
    });
    expect(db.data.get("runLogin")).toMatchObject([
      { filledAt: expect.any(Date), filledComputerId: "computer-1" },
    ]);
  });

  it("isn't typed on a second computer, whose cleanup wouldn't close the first's page", async () => {
    const db = database({ runLogin: [await runLogin("run-1")] });
    expect(
      await resolveLoginFill({
        computerId: "computer-2",
        prisma: db.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "site_login",
        field: "password",
      }),
    ).toEqual({ error: RUN_LOGIN_ON_ANOTHER_COMPUTER });
    expect(db.data.get("runLogin")).toMatchObject([{ filledComputerId: "computer-1" }]);
  });

  it("isn't filled when its run ends between reading it and marking it filled", async () => {
    const db = database({ runLogin: [{ ...(await runLogin("run-1")), filledAt: null }] });
    // The run ends right after the login is read: the unfilled row is deleted.
    const updateMany = vi.fn(async () => ({ count: 0 }));
    Object.assign(db.prisma.runLogin, { updateMany });
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        prisma: db.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "site_login",
        field: "password",
      }),
    ).toEqual({ error: "Login is unavailable. Use request_secret to save it first." });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        endedAt: null,
        OR: [{ filledComputerId: null }, { filledComputerId: "computer-1" }],
      },
      data: { filledAt: expect.any(Date), filledComputerId: "computer-1" },
    });
  });

  it("goes on in the continuation that takes over from it", async () => {
    const db = database({ runLogin: [await runLogin("run-1")] });
    await moveRunLoginsInTransaction(db.prisma, "run-1", "run-2");
    await deleteRunSecretsInTransaction(db.prisma, [{ id: "run-1", ...scope }]);
    expect(
      await resolveLoginFill({
        computerId: "computer-1",
        prisma: db.prisma,
        secretStore,
        scope,
        runId: "run-2",
        name: "site_login",
        field: "password",
      }),
    ).toMatchObject({ text: "password-run-1" });
    expect(await loadRunLoginRedactions(db.prisma, secretStore, scope, "run-2")).toContain(
      "password-run-1",
    );
  });

  it("ends early when the bot forgets it", async () => {
    const db = database({ runLogin: [await runLogin("run-1")] });
    await forgetRunLogin(db.prisma, scope, "run-1", "site_login");
    expect(db.data.get("runLogin")).toMatchObject([{ ciphertext: "", endedAt: expect.any(Date) }]);
  });
});
