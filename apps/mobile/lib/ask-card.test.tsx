// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Render the screen's actual ask card without importing its native dependencies.
// Keep Vitest's jsdom URL transform from replacing the file URL with self.location.
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const cardSource = source.slice(
  source.indexOf("function AskBlock({"),
  source.indexOf("const askInputStyles = StyleSheet.create("),
);
const scope = {
  React,
  useState,
  useMobileTokens: () => ({}),
  useI18n: () => ({ t: (text: string) => text }),
  isSecretAskBlock: (block: { input?: string }) => block.input === "secret",
  plainAskTitle: (text: string) => text,
  secretDestinationLabel: (credential: { origin: string }) => credential.origin,
  secretFieldTraits: () => ({}),
  errorText: (_error: unknown, fallback: string) => fallback,
  askInputStyles: { field: {} },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, numberOfLines }: { children?: ReactNode; numberOfLines?: number }) => (
    <span data-lines={numberOfLines}>{children}</span>
  ),
  TextInput: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
    <input aria-label={accessibilityLabel} />
  ),
  NativeActionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
  SecretAskSheet: () => null,
};
const AskBlock = new Function(
  ...Object.keys(scope),
  ts.transpileModule(`${cardSource}\nreturn AskBlock;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(...Object.values(scope));

const longTitle = "Sign in to the example account so I can finish the export you asked for";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render(ask: Record<string, unknown>) {
  await act(async () =>
    root.render(
      <AskBlock
        ask={{ kind: "ask", text: longTitle, status: "pending", ...ask }}
        canAnswer
        onAnswer={async () => undefined}
        actionProps={{}}
      />,
    ),
  );
  return container.querySelector("span")!;
}

it("caps a secret card's title at two lines and leaves question titles whole", async () => {
  const login = await render({
    input: "secret",
    purpose: "password",
    credential: {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    },
  });
  expect(login.textContent).toBe(longTitle);
  expect(login.dataset.lines).toBe("2");
  expect(container.textContent).toContain("https://login.example.test");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")?.textContent).toBe("Continue");

  expect((await render({ input: "secret", purpose: "otp" })).dataset.lines).toBe("2");
  expect((await render({})).dataset.lines).toBeUndefined();
});
