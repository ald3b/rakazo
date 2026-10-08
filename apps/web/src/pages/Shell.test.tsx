// @vitest-environment jsdom

import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import type { ComponentProps, ReactNode } from "react";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { Composer } from "./Shell";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const bob: ComposerMention = { kind: "bot", id: "bot-2", name: "Bob" };
const summarize: AgentSkillCatalogEntry = {
  id: "skill-1",
  name: "summarize",
  description: "Summarize a document",
  source: "user",
  readOnly: false,
};

function renderComposer(onSend: ComponentProps<typeof Composer>["onSend"]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion skips the chip-row resize animation, which jsdom cannot run.
  window.matchMedia ??= () => ({ matches: true }) as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <Composer
        activeName="Ada"
        running={false}
        pendingAttachments={[]}
        attachmentNotice={null}
        sendError={null}
        runError={null}
        runErrorId={null}
        onRunErrorPresented={() => {}}
        onDismissError={() => {}}
        sending={false}
        fileInputRef={createRef()}
        onAttachmentPick={() => {}}
        onRemoveAttachment={() => {}}
        onSend={onSend}
        onStop={async () => {}}
        mentionTargets={[bob]}
        agentSkills={[summarize]}
      />,
    ),
  );
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(textarea: HTMLTextAreaElement) {
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("Composer", () => {
  it("clears the draft once the message is sent", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const textarea = renderComposer(onSend);
    type(textarea, "hello");
    pressEnter(textarea);
    await act(async () => {});
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(textarea.value).toBe("");
  });

  it("restores the draft and its mentions when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const mentionChips = () =>
      [...(container?.querySelectorAll("[data-testid='mention-chip']") ?? [])].map(
        (chip) => chip.textContent,
      );
    type(textarea, "@Bo");
    pressEnter(textarea);
    type(textarea, "hello");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("@Bob hello", [bob]);
    expect(textarea.value).toBe("");
    expect(mentionChips()).toEqual([]);
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("hello");
    expect(mentionChips()).toEqual(["Bob"]);
  });

  it("restores the chosen skill when the send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    const textarea = renderComposer(onSend);
    const skillChip = () => container?.querySelector("[data-testid='skill-chip']")?.textContent;
    type(textarea, "/sum");
    act(() =>
      container?.querySelector<HTMLButtonElement>("button[aria-label='Skill summarize']")?.click(),
    );
    type(textarea, "the notes");
    pressEnter(textarea);
    expect(onSend).toHaveBeenCalledWith("/summarize\nthe notes", []);
    expect(skillChip()).toBeUndefined();
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("the notes");
    expect(skillChip()).toBe("summarize");
  });

  it("keeps a newer draft when an earlier send fails", async () => {
    let finishSend = (_sent: boolean) => {};
    const textarea = renderComposer(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve;
        }),
    );
    type(textarea, "hello");
    pressEnter(textarea);
    type(textarea, "newer");
    await act(async () => finishSend(false));
    expect(textarea.value).toBe("newer");
  });
});
