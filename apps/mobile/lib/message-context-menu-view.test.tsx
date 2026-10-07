import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    Platform: { OS: "ios" },
    Pressable: (props: { children?: ReactNode }) =>
      createElement("rn-pressable", null, props.children),
    View: (props: { children?: ReactNode; style?: { maxWidth?: number } }) =>
      createElement("rn-view", { "data-max-width": props.style?.maxWidth }, props.children),
  };
});

// SwiftUI hosting: the native layout only applies the hosted root's own point limits.
vi.mock("@expo/ui/community/menu", async () => {
  const { createElement } = await import("react");
  return {
    MenuView: (props: { children?: ReactNode }) =>
      createElement("swiftui-host", null, props.children),
  };
});

import { MessageContextMenu } from "../components/message-context-menu";
import { threadBubbleMaxWidth } from "./message-presentation";

describe("iOS message context menu", () => {
  it("caps the hosted bubble in points, since the native layout ignores the row's percentages", () => {
    const maxWidth = threadBubbleMaxWidth(393, { centered: false });
    const html = renderToStaticMarkup(
      <MessageContextMenu actions={[]} colorScheme="light" maxWidth={maxWidth} onAction={() => {}}>
        <span>Bubble</span>
      </MessageContextMenu>,
    );

    expect(html).toBe(
      `<swiftui-host><rn-view data-max-width="${maxWidth}"><span>Bubble</span></rn-view></swiftui-host>`,
    );
  });
});
