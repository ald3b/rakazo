import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { toast } from "./toast";
import { errorText } from "./user-error";

/**
 * A failed send keeps its client nonce and finished uploads. Sending the same draft again
 * (Retry, or Send) reuses them, so a send the server already accepted replays instead of
 * posting the message or its files twice; an edited draft starts a fresh attempt.
 */
export type SendAttempt = {
  draft: string;
  clientNonce: string;
  /** Uploaded artifact id per pending attachment id. */
  artifactIds: Map<string, string>;
};

/**
 * How a thread reports trouble: a failed action as a toast, a failed send as a toast with Retry,
 * and a failed load as the line above the thread until the server answers again.
 */
export function useThreadFeedback(threadKey: string | undefined, newNonce: () => string) {
  const [error, setError] = useState<string | null>(null);
  const failedSend = useRef<SendAttempt | null>(null);
  const sendToastKey = `send:${threadKey}`;

  useEffect(() => {
    setError(null);
    failedSend.current = null;
    // Retry belongs to the thread whose draft failed to send.
    return () => toast.dismiss(sendToastKey);
  }, [sendToastKey]);

  return {
    error,
    setError,
    /** A refresh reached the server, so an earlier load failure no longer describes the thread. */
    refreshed: () => setError(null),
    sendAttempt(draft: string): SendAttempt {
      const failed = failedSend.current;
      if (failed?.draft === draft) return failed;
      return { draft, clientNonce: newNonce(), artifactIds: new Map() };
    },
    sent() {
      failedSend.current = null;
    },
    /** The draft stays in the composer; Retry sends it again as the same attempt. */
    sendFailed(attempt: SendAttempt, cause: unknown, retry: () => void) {
      failedSend.current = attempt;
      toast.show(errorText(cause, t("Failed to send message")), {
        variant: "error",
        action: { label: t("Retry"), run: retry },
        dedupeKey: sendToastKey,
      });
    },
    actionFailed(cause: unknown, fallback: string) {
      toast.show(errorText(cause, fallback), { variant: "error" });
    },
  };
}
