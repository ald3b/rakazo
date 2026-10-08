// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChangePassword from "../app/change-password";
import NewSpace from "../app/new-space";

const { api, router, showToast } = vi.hoisted(() => ({
  api: { rpc: vi.fn(), selectSpace: vi.fn(), changePassword: vi.fn() },
  router: { dismissAll: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => true },
  showToast: vi.fn(),
}));

vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    KeyboardAvoidingView: box,
    Platform: { OS: "ios" },
    ScrollView: box,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: (props: { placeholder?: string; onChangeText?: (text: string) => void }) =>
      createElement("input", {
        "aria-label": props.placeholder,
        onChange: (event: { target: { value: string } }) =>
          props.onChangeText?.(event.target.value),
      }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null }, useRouter: () => router }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/sheet-header", () => ({ cancelHeaderOptions: () => ({}) }));
vi.mock("./api", () => api);
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({
  native: {},
  useMobileTokens: () => ({}),
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./toast", () => ({ toast: { show: showToast } }));

let root: Root;
let container: HTMLDivElement;

function type(label: string, value: string) {
  const input = Array.from(container.querySelectorAll("input")).find(
    (item) => item.getAttribute("aria-label") === label,
  );
  if (!input) throw new Error(`No input ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (!button) throw new Error(`No button ${label}`);
  await act(async () => button.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("notices shown as toasts", () => {
  it("confirms a password change with a success toast", async () => {
    api.changePassword.mockResolvedValue(undefined);
    act(() => root.render(<ChangePassword />));
    type("Current password", "old-password");
    type("New password", "new-password");
    type("Confirm password", "new-password");
    await press("Change password");

    expect(api.changePassword).toHaveBeenCalledWith("old-password", "new-password");
    expect(showToast).toHaveBeenCalledWith("Password updated", { variant: "success" });
  });

  it("tells that a new space could not be opened with an info toast", async () => {
    api.rpc.mockResolvedValue({ id: "space-new" });
    api.selectSpace.mockResolvedValue(false);
    act(() => root.render(<NewSpace />));
    type("Customer support", "Garden");
    await press("Create space");

    expect(showToast).toHaveBeenCalledWith("Space created", {
      variant: "info",
      detail: "It could not be opened. Try again from the sidebar.",
    });
    expect(router.replace).toHaveBeenCalledWith("/");
  });
});
