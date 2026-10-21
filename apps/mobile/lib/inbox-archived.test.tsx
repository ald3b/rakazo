// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import * as React from "react";
import { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { loadArchivedChats } from "./archived-chats";
import {
  archivedChatCounts,
  notifyArchivedChatsChanged,
  onArchivedChatsChanged,
} from "./archived-chats";

vi.mock("./api", () => ({ rpc: vi.fn() }));

const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/index.tsx", testFileUrl), "utf8");
const slice = (start: string, end: string) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};
const compile = (text: string) =>
  ts.transpileModule(text, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

describe("archived chats row", () => {
  const ArchivedChatsRow = new Function(
    "React",
    "useThemedStyles",
    "useI18n",
    "View",
    "Pressable",
    "Text",
    "NativeSymbol",
    "native",
    "createHomeStyles",
    compile(
      `${slice("function ArchivedChatsRow(", "/** Points right while a section")}\nreturn ArchivedChatsRow;`,
    ),
  )(
    React,
    () => ({}),
    () => ({ t: (text: string) => text }),
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ({
      children,
      accessibilityRole,
      accessibilityLabel,
      onPress,
    }: {
      children: ReactNode;
      accessibilityRole: string;
      accessibilityLabel: string;
      onPress: () => void;
    }) => (
      <button
        type="button"
        data-role={accessibilityRole}
        aria-label={accessibilityLabel}
        onClick={onPress}
      >
        {children}
      </button>
    ),
    ({ children }: { children: ReactNode }) => <span>{children}</span>,
    ({ ios }: { ios: string }) => <i data-symbol={ios} />,
    { tertiaryLabel: "tertiary" },
    () => ({}),
  ) as (props: { count: number; onPress: () => void }) => ReactNode;

  function render(count: number) {
    const onPress = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<ArchivedChatsRow count={count} onPress={onPress} />));
    return { container, root, onPress };
  }

  it("shows nothing until a chat is archived", () => {
    const { container, root } = render(0);
    expect(container.innerHTML).toBe("");
    act(() => root.unmount());
  });

  it("names the archive with its count and a chevron, and opens it", () => {
    const { container, root, onPress } = render(3);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("data-role")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Archived, 3");
    expect(Array.from(button.querySelectorAll("span"), (span) => span.textContent)).toEqual([
      "Archived",
      "3",
    ]);
    expect(button.querySelector("i")?.getAttribute("data-symbol")).toBe("chevron.right");
    act(() => button.click());
    expect(onPress).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("sits at the very end of the inbox list and opens the existing Archived screen", () => {
    const footer = slice("ListFooterComponent={", "renderItem={renderItem}");
    const row = footer.indexOf("<ArchivedChatsRow");
    expect(row).toBeGreaterThan(footer.indexOf('t("Tap + to create a bot")'));
    expect(footer.slice(row)).toContain('onPress={() => router.push("/archived-bots")}');
    expect(footer.slice(footer.indexOf("/>", row) + 2).trim()).toBe("</>\n            }");
  });
});

describe("archived count", () => {
  const load = vi.fn<typeof loadArchivedChats>();
  const counter = new Function(
    "React",
    "useCallback",
    "useEffect",
    "useRef",
    "useState",
    "useFocusEffect",
    "loadArchivedChats",
    "archivedChatCounts",
    "onArchivedChatsChanged",
    compile(`return function Counter({ me, hasSession }) {
      const [archived, setArchived] = useState({ spaceId: "", count: 0 });
      const archivedCounts = useRef({ spaceId: "", bots: 0, groups: 0 });
      const archivedRequestId = useRef(0);
      ${slice("  const spaceId = me?.spaceId;", "  const loadActivity = useCallback(")}
      return React.createElement("span", null, String(archivedCount));
    };`),
  );

  function setup() {
    // The inbox stays focused here; expo-router reruns the effect when its callback changes.
    const useFocusEffect = (effect: () => (() => void) | undefined) => useEffect(effect, [effect]);
    const Counter = counter(
      React,
      useCallback,
      useEffect,
      useRef,
      useState,
      useFocusEffect,
      load,
      archivedChatCounts,
      onArchivedChatsChanged,
    ) as (props: { me: { spaceId: string } | null; hasSession: boolean }) => ReactNode;
    const container = document.createElement("div");
    const root = createRoot(container);
    const show = async (spaceId: string | null) => {
      await act(async () =>
        root.render(<Counter me={spaceId ? { spaceId } : null} hasSession={spaceId !== null} />),
      );
    };
    return { container, root, show };
  }

  const lists = (bots: number, groups: number) => ({
    bots: Array.from({ length: bots }, () => ({}) as never),
    groups: Array.from({ length: groups }, () => ({}) as never),
    error: undefined,
  });

  beforeEach(() => load.mockReset());

  it("counts archived bots and groups when the inbox is shown, and waits for a session", async () => {
    load.mockResolvedValue(lists(2, 1));
    const h = setup();
    await h.show(null);
    expect(load).not.toHaveBeenCalled();
    await h.show("space-a");
    expect(load).toHaveBeenCalledOnce();
    expect(h.container.textContent).toBe("3");
    act(() => h.root.unmount());
  });

  it("recounts when a chat is archived or restored, without polling", async () => {
    load.mockResolvedValueOnce(lists(0, 0));
    const h = setup();
    await h.show("space-a");
    expect(h.container.textContent).toBe("0");
    load.mockResolvedValueOnce(lists(1, 0));
    await act(async () => notifyArchivedChatsChanged());
    expect(h.container.textContent).toBe("1");
    load.mockResolvedValueOnce(lists(0, 0));
    await act(async () => notifyArchivedChatsChanged());
    expect(h.container.textContent).toBe("0");
    expect(load).toHaveBeenCalledTimes(3);
    act(() => h.root.unmount());
    // An unmounted inbox stops listening.
    await act(async () => notifyArchivedChatsChanged());
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps a list's last count when it fails, but not across spaces", async () => {
    load.mockResolvedValueOnce(lists(2, 1));
    const h = setup();
    await h.show("space-a");
    load.mockResolvedValueOnce({ ...lists(0, 0), bots: null, error: new Error("offline") });
    await act(async () => notifyArchivedChatsChanged());
    expect(h.container.textContent).toBe("2");
    load.mockResolvedValueOnce({ ...lists(0, 0), bots: null, error: new Error("offline") });
    await h.show("space-b");
    expect(h.container.textContent).toBe("0");
    act(() => h.root.unmount());
  });

  it("never shows another space's count while the new space's count is loading", async () => {
    load.mockResolvedValueOnce(lists(2, 1));
    const h = setup();
    await h.show("space-a");
    expect(h.container.textContent).toBe("3");
    let finish!: (value: ReturnType<typeof lists>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await h.show("space-b");
    expect(h.container.textContent).toBe("0");
    await act(async () => finish(lists(1, 0)));
    expect(h.container.textContent).toBe("1");
    act(() => h.root.unmount());
  });

  it("shows only the newest count when loads overlap", async () => {
    let finishOld!: (value: ReturnType<typeof lists>) => void;
    load.mockReturnValueOnce(new Promise((resolve) => (finishOld = resolve)));
    const h = setup();
    await h.show("space-a");
    load.mockResolvedValueOnce(lists(1, 0));
    await act(async () => notifyArchivedChatsChanged());
    await act(async () => finishOld(lists(5, 5)));
    expect(h.container.textContent).toBe("1");
    act(() => h.root.unmount());
  });
});
