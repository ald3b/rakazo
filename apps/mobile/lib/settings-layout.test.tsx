// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsLayout from "../app/(settings)/_layout";

type HeaderItem = { label: string; onPress: () => void };
type ScreenOptions = (props: {
  navigation: { getState: () => { routes: { key: string }[] } };
  route: { key: string };
}) => { unstable_headerLeftItems?: () => HeaderItem[]; headerLeft?: () => HeaderItem };

const { stack, sheet } = vi.hoisted(() => ({
  stack: { screenOptions: undefined as ScreenOptions | undefined },
  sheet: { canGoBack: vi.fn(), goBack: vi.fn(), dispatch: vi.fn() },
}));

vi.mock("expo-router", () => {
  function Stack(props: { screenOptions: ScreenOptions; children?: ReactNode }) {
    stack.screenOptions = props.screenOptions;
    return null;
  }
  Stack.Screen = () => null;
  return { Stack, useNavigation: () => sheet };
});
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("../components/glass-title", () => ({
  floatingHeaderOptions: () => ({}),
  glassHeaderOptions: (title: string) => ({ title }),
}));
vi.mock("../components/sheet-header", () => ({
  cancelHeaderOptions: (label: string, onPress: () => void) => ({
    headerLeft: () => ({ label, onPress }),
  }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ native: {}, useMobileTokens: () => ({}) }));

function headerItems(page: string, pages: string[]) {
  const options = stack.screenOptions!({
    navigation: { getState: () => ({ routes: pages.map((key) => ({ key })) }) },
    route: { key: page },
  });
  return options.unstable_headerLeftItems?.() ?? (options.headerLeft ? [options.headerLeft()] : []);
}

describe("settings sheet header", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Platform.OS = "ios";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<SettingsLayout />));
    act(() => root.unmount());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes the sheet from its first page back to the screen under it", () => {
    sheet.canGoBack.mockReturnValue(true);
    const [close] = headerItems("account", ["account"]);
    expect(close?.label).toBe("Dismiss");
    close?.onPress();

    expect(sheet.goBack).toHaveBeenCalledTimes(1);
    expect(headerItems("models", ["account", "models"])).toEqual([]);
  });

  it.each(["account", "change-password"])("leaves a cold deep link to %s for Home", (page) => {
    sheet.canGoBack.mockReturnValue(false);
    const [close] = headerItems(page, [page]);
    close?.onPress();

    expect(sheet.goBack).not.toHaveBeenCalled();
    expect(sheet.dispatch).toHaveBeenCalledWith({ type: "REPLACE", payload: { name: "index" } });
  });

  it.each(["account", "change-password"])(
    "shows a close button for a cold Android deep link to %s",
    (page) => {
      Platform.OS = "android";
      sheet.canGoBack.mockReturnValue(false);
      const [close] = headerItems(page, [page]);
      expect(close?.label).toBe("Dismiss");
      close?.onPress();
      expect(sheet.dispatch).toHaveBeenCalledWith({ type: "REPLACE", payload: { name: "index" } });
      sheet.canGoBack.mockReturnValue(true);
      expect(headerItems(page, [page])).toEqual([]);
    },
  );
});
