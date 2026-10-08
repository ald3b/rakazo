import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { toast } from "./toast";
import { errorText } from "./user-error";

/**
 * One send of a composer draft. A failed attempt keeps its request, client nonce and finished
 * uploads: sending the same draft again reuses them, and Retry sends exactly this attempt, so a
 * send the server already accepted replays instead of posting the message or its files twice.
 */
export type SendAttempt<Request> = {
  draft: string;
  request: Request;
  /** The thread whose composer held the draft. */
  threadKey: string | undefined;
  clientNonce: string;
  /** Uploaded artifact id per pending attachment id. */
  artifactIds: Map<string, string>;
};

/**
 * How a thread reports trouble: a failed action as a toast, a failed send as a toast with Retry,
 * and a failed load as the line above the thread until the server answers again.
 */
export function useThreadFeedback<Request>(threadKey: string | undefined, newNonce: () => string) {
  const [error, setError] = useState<string | null>(null);
  const failedSend = useRef<SendAttempt<Request> | null>(null);
  const shown = useRef({ threadKey, focused: false });
  shown.current.threadKey = threadKey;
  const sendToastKey = `send:${threadKey}`;

  useEffect(() => {
    setError(null);
    failedSend.current = null;
    // Retry belongs to the thread whose draft failed to send.
    return () => toast.dismiss(sendToastKey);
  }, [sendToastKey]);

  // A pushed screen keeps this one mounted underneath; its Retry must not follow the user there.
  useFocusEffect(
    useCallback(() => {
      shown.current.focused = true;
      return () => {
        shown.current.focused = false;
        toast.dismiss(sendToastKey);
      };
    }, [sendToastKey]),
  );

  return {
    error,
    setError,
    /** A refresh reached the server, so an earlier load failure no longer describes the thread. */
    refreshed: () => setError(null),
    sendAttempt(draft: string, request: Request): SendAttempt<Request> {
      const failed = failedSend.current;
      if (failed?.draft === draft) return failed;
      return { draft, request, threadKey, clientNonce: newNonce(), artifactIds: new Map() };
    },
    /** Any successful send retires the failed attempt and its Retry. */
    sent() {
      failedSend.current = null;
      toast.dismiss(sendToastKey);
    },
    /**
     * Retry resends the failed attempt itself, never the composer, and only while it is still the
     * thread's open failure. A failure the user can't see from its own thread gets no Retry.
     */
    sendFailed(
      attempt: SendAttempt<Request>,
      cause: unknown,
      retry: (attempt: SendAttempt<Request>) => void,
    ) {
      const message = errorText(cause, t("Failed to send message"));
      if (attempt.threadKey !== shown.current.threadKey) {
        toast.show(message, { variant: "error" });
        return;
      }
      // Sending the kept draft again later still reuses this attempt.
      failedSend.current = attempt;
      if (!shown.current.focused) {
        toast.show(message, { variant: "error" });
        return;
      }
      toast.show(message, {
        variant: "error",
        action: {
          label: t("Retry"),
          run: () => {
            if (failedSend.current === attempt) retry(attempt);
          },
        },
        dedupeKey: sendToastKey,
      });
    },
    actionFailed(cause: unknown, fallback: string) {
      toast.show(errorText(cause, fallback), { variant: "error" });
    },
  };
}
