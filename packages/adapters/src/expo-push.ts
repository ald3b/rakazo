import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
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

export async function loadPushToken(dataDir: string, userId: string): Promise<string | undefined> {
  return (await readPushToken(dataDir, userId))?.token;
}

/** The file holds the token, then the id of the session that registered it. */
async function readPushToken(
  dataDir: string,
  userId: string,
): Promise<{ token: string; sessionId?: string } | undefined> {
  try {
    const handle = await open(pushTokenPath(dataDir, userId), constants.O_RDONLY | O_NOFOLLOW);
    try {
      const [token, sessionId] = (await handle.readFile("utf8")).trim().split("\n");
      return token ? { token, sessionId } : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * A device token belongs to one account: saving it removes it from every other
 * user, so a handed-over device stops receiving the previous account's pushes.
 */
export async function savePushToken(
  dataDir: string,
  userId: string,
  token: string,
  sessionId?: string,
): Promise<void> {
  const file = pushTokenPath(dataDir, userId);
  const value = token.trim();
  await mkdir(path.dirname(file), { recursive: true });
  // Renamed into place, so a concurrent read sees the old or the new token, never an empty file.
  const staging = path.join(path.dirname(file), `.${userId}.${randomUUID()}.tmp`);
  const handle = await open(
    staging,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(sessionId ? `${value}\n${sessionId}` : value, "utf8");
  } finally {
    await handle.close();
  }
  await rename(staging, file).catch(async (error: unknown) => {
    await unlink(staging).catch(() => undefined);
    throw error;
  });
  // Written first, so concurrent claims of one token can only drop it, never share it.
  for (const name of await readdir(path.dirname(file))) {
    const otherUserId = path.basename(name, ".txt");
    if (!name.endsWith(".txt") || otherUserId === userId) continue;
    if ((await loadPushToken(dataDir, otherUserId)) === value) {
      await deletePushToken(dataDir, otherUserId);
    }
  }
}

export async function deletePushToken(dataDir: string, userId: string): Promise<void> {
  await unlink(pushTokenPath(dataDir, userId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/**
 * Ends the token registered by a session that is gone, so a revoked or signed-out
 * device stops receiving pushes. A session replaced by `nextSessionId` keeps it.
 */
export async function endSessionPushToken(
  dataDir: string,
  userId: string,
  sessionId: string,
  nextSessionId?: string,
): Promise<void> {
  const saved = await readPushToken(dataDir, userId);
  if (saved?.sessionId !== sessionId) return;
  if (nextSessionId) await savePushToken(dataDir, userId, saved.token, nextSessionId);
  else await deletePushToken(dataDir, userId);
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
  constructor(private readonly dataDir: string) {}

  describe() {
    return {
      id: "expo-push",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: true, email: false },
    };
  }

  async hasPushRecipient(userId: string): Promise<boolean> {
    return Boolean(await loadPushToken(this.dataDir, userId));
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
    const token = await loadPushToken(this.dataDir, context.userId);
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
