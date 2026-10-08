// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadFeedback } from "./thread-feedback";
import type { ToastState } from "./toast";
import { toast, useToastState } from "./toast";

vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});

let feedback: ReturnType<typeof useThreadFeedback>;
let shown: ToastState;
let nonces = 0;

function Probe({ threadKey }: { threadKey: string }) {
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`);
  shown = useToastState();
  return null;
}

describe("thread feedback", () => {
  let root: Root;
  let container: HTMLDivElement;

  function render(threadKey: string) {
    act(() => root.render(<Probe threadKey={threadKey} />));
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

  it("reports a failed send with a Retry that sends again", () => {
    const retry = vi.fn();
    const attempt = feedback.sendAttempt("draft");
    act(() => feedback.sendFailed(attempt, new Error("Network down"), retry));

    expect(shown?.toast).toMatchObject({
      message: "Network down",
      variant: "error",
      action: { label: "Retry" },
    });
    shown?.toast.action?.run();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("reuses a failed attempt's nonce and uploads for the same draft only", () => {
    const failed = feedback.sendAttempt("draft");
    failed.artifactIds.set("attachment-1", "artifact-1");
    act(() => feedback.sendFailed(failed, new Error("Timed out"), vi.fn()));

    const retry = feedback.sendAttempt("draft");
    expect(retry.clientNonce).toBe(failed.clientNonce);
    expect(retry.artifactIds.get("attachment-1")).toBe("artifact-1");

    const edited = feedback.sendAttempt("edited draft");
    expect(edited.clientNonce).not.toBe(failed.clientNonce);
    expect(edited.artifactIds.size).toBe(0);
  });

  it("starts fresh after a send goes through", () => {
    const failed = feedback.sendAttempt("draft");
    act(() => feedback.sendFailed(failed, new Error("Timed out"), vi.fn()));
    feedback.sent();

    expect(feedback.sendAttempt("draft").clientNonce).not.toBe(failed.clientNonce);
  });

  it("drops the Retry and the failed attempt when the thread changes", () => {
    const failed = feedback.sendAttempt("draft");
    act(() => feedback.sendFailed(failed, new Error("Timed out"), vi.fn()));
    act(() => feedback.setError("Could not reach the server"));

    render("bot-2");
    expect(shown).toMatchObject({ leaving: true });
    expect(feedback.error).toBeNull();
    expect(feedback.sendAttempt("draft").clientNonce).not.toBe(failed.clientNonce);
  });

  it("drops the Retry when the thread closes", () => {
    act(() => feedback.sendFailed(feedback.sendAttempt("draft"), new Error("x"), vi.fn()));
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
