// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadFeedback } from "./thread-feedback";
import type { ToastState } from "./toast";
import { toast, useToastState } from "./toast";

const focus = vi.hoisted(() => ({ blur: undefined as (() => void) | undefined }));

vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    // Focused while mounted; blur() runs the effect's cleanup as navigating away would.
    useFocusEffect: (effect: () => (() => void) | undefined) => {
      useEffect(() => {
        const cleanup = effect();
        focus.blur = cleanup;
        return () => {
          if (focus.blur === cleanup) cleanup?.();
          focus.blur = undefined;
        };
      }, [effect]);
    },
  };
});
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});

type Request = { text: string };
let feedback: ReturnType<typeof useThreadFeedback<Request>>;
let shown: ToastState;
let nonces = 0;

function Probe({ threadKey }: { threadKey: string }) {
  feedback = useThreadFeedback<Request>(threadKey, () => `nonce-${++nonces}`);
  shown = useToastState();
  return null;
}

describe("thread feedback", () => {
  let root: Root;
  let container: HTMLDivElement;

  function render(threadKey: string) {
    act(() => root.render(<Probe threadKey={threadKey} />));
  }

  function blur() {
    act(() => {
      const cleanup = focus.blur;
      focus.blur = undefined;
      cleanup?.();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    render("bot-1");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      toast.clear();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries exactly the failed attempt, not what the composer holds later", () => {
    const retry = vi.fn();
    const attempt = feedback.sendAttempt("draft", { text: "Hello" });
    act(() => feedback.sendFailed(attempt, new Error("Network down"), retry));

    expect(shown?.toast).toMatchObject({
      message: "Network down",
      variant: "error",
      action: { label: "Retry" },
    });
    shown?.toast.action?.run();
    expect(retry).toHaveBeenCalledExactlyOnceWith(attempt);
    expect(retry.mock.calls[0]?.[0].request).toEqual({ text: "Hello" });
  });

  it("reuses a failed attempt's nonce and uploads for the same draft only", () => {
    const failed = feedback.sendAttempt("draft", { text: "Hello" });
    failed.artifactIds.set("attachment-1", "artifact-1");
    act(() => feedback.sendFailed(failed, new Error("Timed out"), vi.fn()));

    const again = feedback.sendAttempt("draft", { text: "Hello" });
    expect(again).toBe(failed);
    expect(again.artifactIds.get("attachment-1")).toBe("artifact-1");

    const edited = feedback.sendAttempt("edited draft", { text: "Hello there" });
    expect(edited.clientNonce).not.toBe(failed.clientNonce);
    expect(edited.artifactIds.size).toBe(0);
  });

  it("retires the failed attempt and its Retry once any send goes through", () => {
    const retry = vi.fn();
    const failed = feedback.sendAttempt("draft", { text: "Hello" });
    act(() => feedback.sendFailed(failed, new Error("Timed out"), retry));
    const staleRetry = shown?.toast.action?.run;

    act(() => feedback.sent());
    expect(shown).toMatchObject({ leaving: true });
    act(() => vi.runAllTimers());
    expect(shown).toBeNull();
    staleRetry?.();
    expect(retry).not.toHaveBeenCalled();
    expect(feedback.sendAttempt("draft", { text: "Hello" }).clientNonce).not.toBe(
      failed.clientNonce,
    );
  });

  it("drops a queued Retry once a send goes through", () => {
    act(() => toast.show("Something else", { variant: "info" }));
    act(() => feedback.sendFailed(feedback.sendAttempt("draft", { text: "Hi" }), {}, vi.fn()));
    act(() => feedback.sent());
    // Once the notice in front of it leaves, nothing follows.
    act(() => vi.advanceTimersByTime(3200 + 220));
    expect(shown).toBeNull();
  });

  it("drops the Retry and the failed attempt when the thread changes", () => {
    const failed = feedback.sendAttempt("draft", { text: "Hello" });
    act(() => feedback.sendFailed(failed, new Error("Timed out"), vi.fn()));
    act(() => feedback.setError("Could not reach the server"));

    render("bot-2");
    expect(shown).toMatchObject({ leaving: true });
    expect(feedback.error).toBeNull();
    expect(feedback.sendAttempt("draft", { text: "Hello" })).not.toBe(failed);
  });

  it("offers no Retry for an attempt from a thread this screen has left", () => {
    const retry = vi.fn();
    const fromBot1 = feedback.sendAttempt("draft", { text: "Hello" });
    render("bot-2");
    act(() => feedback.sendFailed(fromBot1, new Error("Timed out"), retry));
    expect(shown?.toast).toMatchObject({ message: "Timed out", variant: "error" });
    expect(shown?.toast.action).toBeUndefined();
  });

  it("drops the Retry when another screen covers the thread", () => {
    act(() => feedback.sendFailed(feedback.sendAttempt("draft", { text: "Hi" }), {}, vi.fn()));
    blur();
    expect(shown).toMatchObject({ leaving: true });
  });

  it("reports a send that fails while the thread is covered without Retry", () => {
    const failed = feedback.sendAttempt("draft", { text: "Hello" });
    blur();
    act(() => feedback.sendFailed(failed, new Error("Timed out"), vi.fn()));
    expect(shown?.toast).toMatchObject({ message: "Timed out", variant: "error" });
    expect(shown?.toast.action).toBeUndefined();
    // The draft is still in that thread's composer; sending it again replays the attempt.
    expect(feedback.sendAttempt("draft", { text: "Hello" })).toBe(failed);
  });

  it("drops the Retry when the thread closes", () => {
    act(() => feedback.sendFailed(feedback.sendAttempt("draft", { text: "Hi" }), {}, vi.fn()));
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<Probe threadKey="bot-1" />));
    expect(shown).toMatchObject({ leaving: true });
  });

  it("keeps a load failure until a refresh reaches the server", () => {
    act(() => feedback.setError("Could not reach the server"));
    expect(feedback.error).toBe("Could not reach the server");

    act(() => feedback.refreshed());
    expect(feedback.error).toBeNull();
  });

  it("reports a failed action as a toast, not the thread line", () => {
    act(() => feedback.actionFailed(new Error("Reaction rejected"), "Could not update reaction"));
    expect(shown?.toast).toMatchObject({ message: "Reaction rejected", variant: "error" });
    expect(shown?.toast.action).toBeUndefined();
    expect(feedback.error).toBeNull();

    act(() => toast.clear());
    act(() => feedback.actionFailed({}, "Could not update reaction"));
    expect(shown?.toast.message).toBe("Could not update reaction");
  });
});
