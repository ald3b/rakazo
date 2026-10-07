import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { combineSignals } from "./connector-safety.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const EXPO_PUSH_TIMEOUT_MS = 15_000;
export const MAX_EXPO_PUSH_RESPONSE_BYTES = 64 * 1024;

/** Data a notification tap uses to open the bot or group thread in its space.
 * `deliveryId` distinguishes this send from another push for the same thread:
 * the Expo request identifier stays the thread id. */
export function expoPushData(message: NotificationMessage, spaceId: string, deliveryId: string) {
  return {
    kind: message.kind,
    botId: message.botId,
    threadId: message.threadId,
    deliveryId,
    ...(spaceId ? { spaceId } : {}),
    ...(message.groupId ? { groupId: message.groupId } : {}),
  };
}

export function pushTokenPath(dataDir: string, userId: string) {
  return path.join(dataDir, "push-tokens", `${userId}.txt`);
}

type PushRecord = { token: string; sessionId?: string };

const PUSH_TOKEN_LOCK_WAIT_MS = 15_000;

/** Registration found that its session was already gone. */
export class PushSessionEndedError extends Error {
  constructor() {
    super("Push session ended");
    this.name = "PushSessionEndedError";
  }
}

/** Expiry of the session that registered a token, or null when that session is gone. */
export type PushSessionExpiresAt = (sessionId: string) => Promise<Date | null>;

export async function loadPushToken(dataDir: string, userId: string): Promise<string | undefined> {
  return (await readPushToken(dataDir, userId))?.token;
}

/** The file holds the token, then the id of the session that registered it. */
async function readPushToken(dataDir: string, userId: string): Promise<PushRecord | undefined> {
  try {
    const handle = await open(pushTokenPath(dataDir, userId), constants.O_RDONLY | O_NOFOLLOW);
    try {
      const [token, sessionId] = (await handle.readFile("utf8")).trim().split("\n");
      return token ? { token, sessionId: sessionId || undefined } : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

type SavePushTokenOptions = {
  /** Checked under the token lock, before the token is published. */
  sessionActive?: () => Promise<boolean>;
  /** Runs under the lock after other owners are read and before they are removed. */
  beforeRemoveOthers?: () => Promise<void>;
};

type EndSessionPushTokenOptions = {
  /** Runs after this account's record is read and before the conditional update. */
  beforeCommit?: () => Promise<void>;
};

/**
 * A device token belongs to one account: saving it removes it from every other
 * user, so a handed-over device stops receiving the previous account's pushes.
 * The session check and the write are one locked step.
 */
export async function savePushToken(
  dataDir: string,
  userId: string,
  token: string,
  sessionId?: string,
  options?: SavePushTokenOptions,
): Promise<void> {
  const value = token.trim();
  await withPushTokenLock(dataDir, async () => {
    if (options?.sessionActive && !(await options.sessionActive())) {
      throw new PushSessionEndedError();
    }
    await writePushTokenFile(dataDir, userId, { token: value, sessionId });
    const dir = path.dirname(pushTokenPath(dataDir, userId));
    const claimed: Array<{ userId: string; record: PushRecord }> = [];
    for (const name of await readdir(dir)) {
      const otherUserId = path.basename(name, ".txt");
      if (!name.endsWith(".txt") || otherUserId === userId) continue;
      const current = await readPushToken(dataDir, otherUserId);
      if (current?.token === value) claimed.push({ userId: otherUserId, record: current });
    }
    await options?.beforeRemoveOthers?.();
    for (const other of claimed) {
      await compareAndSwapPushToken(dataDir, other.userId, other.record, undefined);
    }
  });
}

export async function deletePushToken(dataDir: string, userId: string): Promise<void> {
  await withPushTokenLock(dataDir, async () => {
    await unlinkOwnedPushToken(dataDir, userId);
  });
}

/**
 * Ends the token registered by a session that is gone. The update lands only
 * when the file still holds that session, so a replacement cannot reclaim a
 * token another account has taken.
 */
export async function endSessionPushToken(
  dataDir: string,
  userId: string,
  sessionId: string,
  nextSessionId?: string,
  options?: EndSessionPushTokenOptions,
): Promise<void> {
  await withPushTokenLock(dataDir, async () => {
    const expected = await readPushToken(dataDir, userId);
    if (expected?.sessionId !== sessionId) return;
    await options?.beforeCommit?.();
    await compareAndSwapPushToken(
      dataDir,
      userId,
      expected,
      nextSessionId ? { token: expected.token, sessionId: nextSessionId } : undefined,
    );
  });
}

function samePushRecord(left: PushRecord | undefined, right: PushRecord | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.token === right.token && left.sessionId === right.sessionId;
}

/** Writes `next` only when the file still equals `expected`. Callers hold the token lock. */
async function compareAndSwapPushToken(
  dataDir: string,
  userId: string,
  expected: PushRecord | undefined,
  next: PushRecord | undefined,
): Promise<boolean> {
  const current = await readPushToken(dataDir, userId);
  if (!samePushRecord(current, expected)) return false;
  if (!next) {
    await unlinkOwnedPushToken(dataDir, userId);
    return true;
  }
  await writePushTokenFile(dataDir, userId, next);
  return true;
}

async function unlinkOwnedPushToken(dataDir: string, userId: string): Promise<void> {
  await unlink(pushTokenPath(dataDir, userId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function writePushTokenFile(
  dataDir: string,
  userId: string,
  record: PushRecord,
): Promise<void> {
  const file = pushTokenPath(dataDir, userId);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  // Renamed into place, so a concurrent read sees the old or the new token, never an empty file.
  const staging = path.join(dir, `.${userId}.${randomUUID()}.tmp`);
  const handle = await open(
    staging,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    const body = record.sessionId ? `${record.token}\n${record.sessionId}` : record.token;
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  await rename(staging, file).catch(async (error: unknown) => {
    await unlink(staging).catch(() => undefined);
    throw error;
  });
}

/**
 * API and worker are separate containers sharing this directory, so the lock
 * is `flock` on the file description. It releases when the holder exits,
 * including a crash, and an empty lock file is not itself the lock.
 */
async function withPushTokenLock<T>(dataDir: string, body: () => Promise<T>): Promise<T> {
  const release = await acquirePushTokenLock(dataDir);
  try {
    return await body();
  } finally {
    await release();
  }
}

async function acquirePushTokenLock(dataDir: string): Promise<() => Promise<void>> {
  const dir = path.join(dataDir, "push-tokens");
  await mkdir(dir, { recursive: true });
  const lockFile = path.join(dir, ".lock");
  const fd = openSync(lockFile, constants.O_CREAT | constants.O_RDWR | O_NOFOLLOW, 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      "flock",
      [
        "-x",
        "-w",
        String(Math.ceil(PUSH_TOKEN_LOCK_WAIT_MS / 1000)),
        "3",
        "sh",
        "-c",
        "echo ready; exec cat",
      ],
      { stdio: ["pipe", "pipe", "ignore", fd] },
    );
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  closeSync(fd);
  let settled = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (settled || !output.includes("ready")) return;
        settled = true;
        resolve();
      });
      child.on("error", (error) => fail(error));
      child.on("exit", () => fail(new Error("Push token update timed out.")));
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  return () =>
    new Promise((resolve) => {
      child.once("exit", () => resolve());
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.stdin?.end();
    });
}

export type ExpoPushTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

export function expoPushTickets(body: unknown): ExpoPushTicket[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.filter((item): item is ExpoPushTicket => Boolean(item) && typeof item === "object");
  }
  if (data && typeof data === "object") return [data as ExpoPushTicket];
  return [];
}

export function expoPushErrorMessage(body: unknown, status: number): string | undefined {
  if (body && typeof body === "object" && "errors" in body) {
    const errors = (body as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((error) => error.message ?? "expo push error").join("; ");
    }
  }
  const failed = expoPushTickets(body).filter((ticket) => ticket.status === "error");
  if (failed.length > 0) {
    return failed
      .map((ticket) => ticket.message ?? ticket.details?.error ?? "expo push ticket error")
      .join("; ");
  }
  if (status < 200 || status >= 300) return `expo push failed (${status})`;
  return undefined;
}

export class ExpoPushProvider implements NotificationProvider {
  constructor(
    private readonly dataDir: string,
    private readonly sessionExpiresAt?: PushSessionExpiresAt,
  ) {}

  describe() {
    return {
      id: "expo-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  async hasPushRecipient(userId: string): Promise<boolean> {
    return Boolean(await this.deliverableToken(userId));
  }

  async send(message: NotificationMessage, context: AdapterContext): Promise<void> {
    await this.deliver(message, context);
  }

  /**
   * Posts the push when a token is registered. `undeliverable` means this user
   * has no token, which is not an Expo acceptance — callers must not record it
   * as a successful reminder.
   */
  async deliver(message: NotificationMessage, context: AdapterContext): Promise<ExpoPushDelivery> {
    const token = await this.deliverableToken(context.userId);
    if (!token) return "undeliverable";
    const signal = combineSignals(context.signal, AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS));
    let response: Response;
    try {
      response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          to: token,
          title: message.title,
          body: message.body,
          collapseId: message.threadId,
          tag: message.threadId,
          data: expoPushData(message, context.spaceId, randomUUID()),
        }),
        signal,
      });
    } catch (error) {
      getLogger().error("expo push request failed", error);
      throw error;
    }
    const body = await readExpoPushBody(response, signal);
    if (response.ok && body === undefined) {
      throw new Error("Expo push returned an invalid response.");
    }
    const failure = expoPushErrorMessage(body, response.status);
    if (!failure) return "delivered";
    getLogger().error(failure);
    throw new Error(failure);
  }

  /**
   * A token bound to a session is delivered only while that session is still
   * live. A missing row is left for session replacement to retarget; an expired
   * row is removed. The token is read again after the lookup so a handover
   * during that wait is not sent.
   */
  private async deliverableToken(userId: string): Promise<string | undefined> {
    const saved = await readPushToken(this.dataDir, userId);
    if (!saved?.token) return undefined;
    if (!saved.sessionId) return saved.token;
    if (!this.sessionExpiresAt) return undefined;
    let expiresAt: Date | null;
    try {
      expiresAt = await this.sessionExpiresAt(saved.sessionId);
    } catch (error) {
      getLogger().error("push session lookup failed", error);
      return undefined;
    }
    if (!expiresAt) return undefined;
    if (expiresAt.getTime() <= Date.now()) {
      await endSessionPushToken(this.dataDir, userId, saved.sessionId);
      return undefined;
    }
    const current = await readPushToken(this.dataDir, userId);
    if (current?.token !== saved.token || current.sessionId !== saved.sessionId) return undefined;
    return current.token;
  }
}

export type ExpoPushDelivery = "delivered" | "undeliverable";

async function readExpoPushBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_EXPO_PUSH_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Expo push response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_EXPO_PUSH_RESPONSE_BYTES, signal);
    if (bytes.byteLength === 0) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Expo push response is too large.");
    }
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
