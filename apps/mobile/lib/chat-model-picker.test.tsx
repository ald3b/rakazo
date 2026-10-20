// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BotModelScreen from "../app/bot-model";
import BotSettingsScreen from "../app/bot-settings";

const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string | undefined>,
  update: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  dismissTo: vi.fn(),
  setParams: vi.fn(),
  setOptions: vi.fn(),
  announce: vi.fn(),
}));

const catalog = Array.from({ length: 11 }, (_, index) => ({
  provider: "openrouter",
  providerName: "OpenRouter",
  id: `vendor/model-${index + 1}`,
  label: `Model ${index + 1}`,
  billing: "",
}));

vi.mock("./api", () => ({
  rpc: async (procedure: string, input?: unknown) => {
    if (procedure === "bots/update") return mocks.update(input);
    if (procedure === "bots/get")
      return { id: "bot-fixture", name: "Fixture", title: "", computerMode: "team" };
    if (procedure === "me") return {};
    if (procedure === "models/list") return catalog;
    if (procedure === "models/credentials")
      return [{ provider: "openrouter", label: "OpenRouter" }];
    return [];
  },
}));
vi.mock("./bot-voices", () => ({
  voiceLabel: () => "",
  deviceVoices: async () => [],
  voiceForBot: async () => undefined,
  setVoiceForBot: async () => undefined,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => false }));
vi.mock("./voice", () => ({ stopVoicePlayback: () => undefined }));
vi.mock("expo-speech", () => ({ stop: async () => undefined, speak: () => undefined }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({
    back: mocks.back,
    push: mocks.push,
    dismissTo: mocks.dismissTo,
    setParams: mocks.setParams,
  }),
  useNavigation: () => ({ setOptions: mocks.setOptions }),
  useLocalSearchParams: () => mocks.params,
  useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityValue,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { text: string };
  }) =>
    createElement(
      "div",
      {
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-valuetext": accessibilityValue?.text,
      },
      children,
    );
  return {
    AccessibilityInfo: { announceForAccessibility: mocks.announce },
    ActivityIndicator: () => null,
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    TextInput: () => null,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityValue,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityValue?: { text: string };
    }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "aria-valuetext": accessibilityValue?.text,
        },
        children,
      ),
    FlatList: ({
      data,
      renderItem,
      keyExtractor,
      ListEmptyComponent,
    }: {
      data: { key: string }[];
      renderItem: (info: { item: { key: string }; index: number }) => ReactNode;
      keyExtractor: (item: { key: string }) => string;
      ListEmptyComponent: ReactNode;
    }) =>
      createElement(
        "ul",
        {},
        data.length
          ? data.map((item, index) =>
              createElement("li", { key: keyExtractor(item) }, renderItem({ item, index })),
            )
          : ListEmptyComponent,
      ),
  };
});
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/settings-group", () => ({
  SettingsFooter: ({ children }: { children: ReactNode }) => createElement("span", {}, children),
  SettingsRow: ({
    title,
    accessibilityState,
    onPress,
    trailing,
  }: {
    title: string;
    accessibilityState: { selected: boolean };
    onPress: () => void;
    trailing: ReactNode;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-selected": accessibilityState.selected, onClick: onPress },
      title,
      trailing,
    ),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("./bot-avatar-edit", () => ({
  avatarColor: (value: string) => value,
  avatarShape: () => null,
  isAvatarPhoto: () => false,
  withAvatarColor: (_value: string, color: string) => color,
  withAvatarShape: (value: string) => value,
}));
vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({
  Chevron: () => null,
  Checkmark: () => createElement("i", { "data-checkmark": true }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "data-menu": title }, children),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("chat settings model row", () => {
  const render = async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Advanced"]')!.click());
  };

  it("opens the searchable model list when there are too many models for a menu", async () => {
    mocks.params = { botId: "bot-fixture" };
    await render();
    expect(container.querySelector('[data-menu="Model"]')).toBeNull();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(row?.getAttribute("aria-valuetext")).toBe("Space default");
    act(() => row!.click());
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-model",
      params: { botId: "bot-fixture", value: "" },
    });
  });

  it("stages the model the list hands back until Save", async () => {
    mocks.params = { botId: "bot-fixture" };
    await render();
    mocks.params = { botId: "bot-fixture", model: "openrouter::vendor/model-3" };
    await act(async () => root.render(<BotSettingsScreen />));
    expect(mocks.setParams).toHaveBeenCalledWith({ model: undefined });
    const row = container.querySelector('button[aria-label="Model"]');
    expect(row?.getAttribute("aria-valuetext")).toBe("OpenRouter · Model 3");
    expect(mocks.update).not.toHaveBeenCalled();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save!.click());
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openrouter", modelId: "vendor/model-3" }),
    );
  });
});

describe("chat model list", () => {
  const search = (text: string) =>
    act(() => {
      const options = mocks.setOptions.mock.lastCall![0];
      options.headerSearchBarOptions.onChangeText({ nativeEvent: { text } });
    });
  const rows = () => [...container.querySelectorAll("li button")];

  it("checks the current model, filters by name or id, and returns the pick", async () => {
    mocks.params = { botId: "bot-fixture", value: "openrouter::vendor/model-2" };
    await act(async () => root.render(<BotModelScreen />));
    expect(rows()).toHaveLength(12);
    expect(rows()[0]!.textContent).toBe("Space default");
    const checked = rows().filter((row) => row.getAttribute("aria-selected") === "true");
    expect(checked.map((row) => row.textContent)).toEqual(["OpenRouter · Model 2"]);
    expect(checked[0]!.querySelector("[data-checkmark]")).not.toBeNull();

    search("MODEL 1");
    expect(rows().map((row) => row.textContent)).toEqual([
      "OpenRouter · Model 1",
      "OpenRouter · Model 10",
      "OpenRouter · Model 11",
    ]);
    search("vendor/model-7");
    expect(rows().map((row) => row.textContent)).toEqual(["OpenRouter · Model 7"]);

    act(() => (rows()[0] as HTMLButtonElement).click());
    expect(mocks.dismissTo).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-settings",
      params: { botId: "bot-fixture", model: "openrouter::vendor/model-7" },
    });
  });

  it("says when nothing matches", async () => {
    mocks.params = { botId: "bot-fixture", value: "" };
    await act(async () => root.render(<BotModelScreen />));
    search("no such model");
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toBe("No matching models");
    expect(mocks.announce).toHaveBeenCalledExactlyOnceWith("No matching models");
  });
});
