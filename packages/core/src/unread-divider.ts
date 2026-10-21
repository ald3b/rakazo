type DividerCandidate = { id: string; role: string; seq?: number };

/**
 * The message the "New" divider sits above: the first bot message after the seq the user
 * had read up to when the chat opened. Their own messages never start it. `olderCursor` is
 * the seq the loaded page starts at, hidden messages included (null once nothing older is
 * left); while the first unread seq is older than that, it waits.
 * `messages` are in reading order.
 */
export function unreadDividerMessageId(
  messages: readonly DividerCandidate[],
  readUpToSeq: number | null,
  olderCursor: number | null,
): string | null {
  if (readUpToSeq === null) return null;
  if (olderCursor !== null && olderCursor > readUpToSeq + 1) return null;
  return (
    messages.find(
      (message) => message.role === "bot" && message.seq !== undefined && message.seq > readUpToSeq,
    )?.id ?? null
  );
}

/** A voice card gets the divider above it when any message inside it starts the unread part. */
export function voiceChatHoldsMessage(
  group: { messages: readonly { id: string }[] },
  messageId: string | null,
): boolean {
  return messageId !== null && group.messages.some((message) => message.id === messageId);
}

/**
 * Runs tasks one at a time, in the order they were queued, whether or not earlier ones fail.
 * markRead calls go through one so their answers arrive in the order they were sent, which
 * lets the first answer of a visit stand for the request that opened it.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** What the open chat's "New" divider follows: the first markRead answer of the visit. */
export type ReadBoundary = { visit: number; seq: number | null };

/**
 * Keeps the first markRead answer of the open visit. An answer that started in an earlier
 * visit, such as a chat the user has since left, is dropped.
 */
export function settleReadBoundary(
  current: ReadBoundary | null,
  openVisit: number,
  answer: ReadBoundary,
): ReadBoundary | null {
  if (answer.visit !== openVisit) return current;
  return current?.visit === openVisit ? current : answer;
}
