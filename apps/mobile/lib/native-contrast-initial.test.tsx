// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const contrast = vi.hoisted(() => ({
  changed: undefined as ((enabled: boolean) => void) | undefined,
  resolveInitial: undefined as ((enabled: boolean) => void) | undefined,
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    addEventListener: (_event: string, handler: (enabled: boolean) => void) => {
      contrast.changed = handler;
      return { remove: () => undefined };
    },
    isDarkerSystemColorsEnabled: () =>
      new Promise<boolean>((resolve) => {
        contrast.resolveInitial = resolve;
      }),
  },
  Platform: { OS: "ios" },
  PlatformColor: (name: string) => `platform:${name}`,
}));

vi.mock("./appearance", () => ({
  getCachedAppearancePreference: () => "system",
  mobileTokens: () => ({ card: "token-card" }),
  resolveMobileAppearance: () => "dark",
  subscribeAppearance: () => () => undefined,
}));

import { native, useThemedStyles } from "./native";

let seen: unknown;

function Probe() {
  seen = useThemedStyles(() => native.groupedCell);
  return null;
}

describe("Increase Contrast initial read", () => {
  it("loses to a change event that arrived before it resolved", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe />);
    });

    act(() => contrast.changed?.(true));
    await act(async () => contrast.resolveInitial?.(false));
    expect(seen).toBe("token-card");

    act(() => root.unmount());
  });
});
