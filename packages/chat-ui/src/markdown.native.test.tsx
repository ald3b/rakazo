// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => undefined),
}));

// react-native ships uncompiled Flow source that node cannot load, so tests mock
// its component surface as marker elements that expose the layout props the
// render rules set (horizontal scrolling, per-row minimum width).
vi.mock("react-native", async () => {
  const { createElement } = await import("react");

  const flattenStyle = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map(flattenStyle))
      : ((style ?? {}) as Record<string, unknown>);

  const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  const mockComponent = (tag: string, dataKeys: string[] = []) =>
    function MockNativeComponent(props: Record<string, unknown>) {
      const {
        children,
        style,
        onPress,
        onLongPress: _onLongPress,
        onAccessibilityAction: _onAccessibilityAction,
        ...rest
      } = props;
      const flattened = flattenStyle(style);
      const data: Record<string, unknown> = {};
      for (const key of dataKeys) {
        const value = rest[key] ?? flattened[key];
        if (value !== undefined && value !== null && value !== false) {
          data[`data-${kebab(key)}`] = value === true ? "true" : value;
        }
      }
      return createElement(
        tag,
        {
          ...rest,
          ...data,
          onClick:
            typeof onPress === "function"
              ? (event: { preventDefault(): void; stopPropagation(): void }) => {
                  (onPress as (pressEvent: typeof event) => void)(event);
                }
              : undefined,
        },
        children as ReactNode,
      );
    };

  return {
    View: mockComponent("rn-view", ["minWidth", "flex", "flexGrow"]),
    Text: mockComponent("rn-text", ["accessibilityRole", "textDecorationLine", "color"]),
    ScrollView: mockComponent("rn-scroll-view", ["horizontal"]),
    Pressable: mockComponent("rn-pressable", [
      "accessibilityRole",
      "borderBottomWidth",
      "backgroundColor",
    ]),
    TextInput: mockComponent("rn-text-input"),
    Image: mockComponent("rn-image"),
    Animated: {
      View: mockComponent("rn-animated-view"),
      createAnimatedComponent: (component: unknown) => component,
      timing: () => ({ start: () => undefined }),
      sequence: (...animations: unknown[]) => animations,
      loop: (animation: unknown) => animation,
      delay: () => ({}),
      Value: class {},
    },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: flattenStyle,
      hairlineWidth: 1,
      absoluteFillObject: {},
      absoluteFill: {},
    },
    Platform: {
      OS: "ios",
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.default ?? options.android,
    },
    Linking: linking,
  };
});

import { darkTokens } from "@rakazo/ui-tokens";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Pressable } from "react-native";
import {
  ChatMarkdown,
  LinkifiedText,
  RemoteImagesContext,
  RemoteMarkdownImage,
} from "./markdown.native";

const THREE_COLUMN_TABLE = `| Name | Status | Detail |
| --- | --- | --- |
| Alice | done | [docs](https://docs.example.test) |
| Bob | queued | A longer note that wraps inside the cell |`;

const SIX_COLUMN_TABLE = `| A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 3 | 4 | 5 | 6 |`;

describe("native markdown tables", () => {
  it("wraps the table in a horizontal scroll view", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("<rn-scroll-view");
    expect(html).toContain('data-horizontal="true"');
  });

  it("sizes each row from its cell count so wide tables scroll instead of collapsing", () => {
    // Rows get a minimum width of TABLE_MIN_COLUMN_WIDTH (96) per cell.
    const narrow = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(narrow).toContain('data-min-width="288"');
    expect(narrow).not.toContain('data-min-width="576"');

    const wide = renderToStaticMarkup(<ChatMarkdown>{SIX_COLUMN_TABLE}</ChatMarkdown>);
    expect(wide).toContain('data-min-width="576"');
  });

  it("renders cell text and keeps inline links tappable inside cells", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{THREE_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("Alice");
    expect(html).toContain("A longer note that wraps inside the cell");
    expect(html).toContain('data-accessibility-role="link"');
    expect(html).toContain('data-text-decoration-line="underline"');
    expect(html).toContain("docs");
  });

  it("applies the same table layout while streaming", () => {
    const html = renderToStaticMarkup(<ChatMarkdown streaming>{SIX_COLUMN_TABLE}</ChatMarkdown>);
    expect(html).toContain("<rn-scroll-view");
    expect(html).toContain('data-min-width="576"');
  });
});

describe("user message links", () => {
  it("opens a link tapped inside a user message bubble's long-press pressables", async () => {
    // The mobile thread wraps a user bubble in two long-press Pressables: the
    // row, then the bubble. A tap on the address still opens it, and markdown
    // markers stay literal characters.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    linking.canOpenURL.mockClear();
    const longPress = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Pressable accessible={false} onLongPress={longPress}>
          <Pressable onLongPress={longPress}>
            <LinkifiedText color={darkTokens.foreground} linkColor={darkTokens.link}>
              {"# Title **important** https://example.com/docs"}
            </LinkifiedText>
          </Pressable>
        </Pressable>,
      );
    });

    const link = container.querySelector<HTMLElement>(
      "rn-pressable rn-pressable [data-accessibility-role='link']",
    );
    expect(link?.textContent).toBe("https://example.com/docs");
    expect(container.textContent).toContain("# Title");
    expect(container.textContent).toContain("**important**");

    await act(async () => {
      link?.click();
    });
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://example.com/docs");
    });
    expect(longPress).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("native markdown lists", () => {
  it("gives list items an intrinsic width instead of a zero flex basis", () => {
    // `flex: 1` on list content collapsed a shrink-wrapped bubble to one character wide.
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- premier point\n- second point"}</ChatMarkdown>,
    );
    expect(html).toContain('data-flex-grow="1"');
    expect(html).not.toContain('data-flex="1"');
    expect(html).toContain("premier point");
    const ordered = renderToStaticMarkup(<ChatMarkdown>{"3. trois\n4. quatre"}</ChatMarkdown>);
    expect(ordered).toContain("3.");
    expect(ordered).toContain("4.");
    expect(ordered).not.toContain('data-flex="1"');
  });

  it("numbers an ordered list nested inside a bulleted one", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"- outer\n  1. first\n  2. second"}</ChatMarkdown>,
    );
    expect(html).toContain("1.");
    expect(html).toContain("2.");
    // One bullet for the outer item, none for the nested numbered items.
    expect(html.split("\u00B7").length - 1).toBe(1);
  });
});

describe("native markdown images", () => {
  it("shows a remote image as a placeholder that loads it in place on tap", async () => {
    const markdown = '![chart](https://images.example.test/tap.png?d=secret "Q3 revenue")';
    const html = renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(html).not.toContain("<rn-stub");
    expect(html).toContain('data-accessibility-role="button"');
    expect(html).toContain('accessibilityLabel="chart, images.example.test"');
    expect(html).toContain('accessibilityHint="Q3 revenue"');
    // A filled chip on the muted bubble reads as a control in both themes.
    expect(html).toContain(`data-background-color="${darkTokens.background}"`);

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("rn-stub")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    expect(container.querySelector("rn-stub")).not.toBeNull();
    expect(container.querySelector("[data-accessibility-role='button']")).toBeNull();
    expect(linking.openURL).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // The reader's choice holds for the session, so a remounted bubble keeps the image.
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain("<rn-stub");
  });

  it("shows a placeholder when a tapped image is replaced with another url", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const image = (href: string) => ({ href, host: "images.example.test" });
    const render = (href: string) => {
      root.render(
        <RemoteMarkdownImage
          image={image(href)}
          alt="chart"
          rejectedLink={false}
          labelStyle={undefined}
          styleMap={{}}
        />,
      );
    };
    await act(async () => {
      render("https://images.example.test/native-first.png");
    });
    await act(async () => {
      container.querySelector<HTMLElement>("[data-accessibility-role='button']")?.click();
    });
    expect(container.querySelector("rn-stub")).not.toBeNull();

    await act(async () => {
      render("https://images.example.test/native-second.png");
    });
    expect(container.querySelector("rn-stub")).toBeNull();
    expect(container.querySelector("[data-accessibility-role='button']")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads remote images at once when the reader turned that on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "![chart](https://images.example.test/auto.png) [![build](https://badge.example.test/auto.svg)](https://ci.example.test/run)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html.match(/<rn-stub/g)).toHaveLength(2);
    expect(html).toContain('data-accessibility-role="link"');
    expect(html).not.toContain('data-accessibility-role="button"');
  });

  it("shows unopenable image sources and unsafe links as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"![logo](/api/v1/p.gif) ![](example.test/p.gif) [x](javascript:alert(1))"}
      </ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">x</rn-text>");
    expect(html).toContain("logo");
    expect(html).toContain("example.test/p.gif");
  });

  it("loads an image inside an open link from its placeholder without following the link", async () => {
    const markdown =
      "See [![build](https://badge.example.test/tap-linked.svg)](https://ci.example.test/tap-linked) now";
    const html = renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>);
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("tap-linked.svg");
    expect(html.match(/data-accessibility-role="link"/g)).toHaveLength(1);
    expect(html).toContain('data-accessibility-role="button"');
    expect(html).toContain("build");
    expect(html).toContain("badge.example.test");

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    linking.openURL.mockClear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("rn-stub")).toBeNull();

    const link = container.querySelector<HTMLElement>("[data-accessibility-role='link']");
    await act(async () => {
      link?.click();
    });
    await vi.waitFor(() => {
      expect(linking.openURL).toHaveBeenCalledWith("https://ci.example.test/tap-linked");
    });
    expect(container.querySelector("rn-stub")).toBeNull();

    linking.openURL.mockClear();
    const button = link?.querySelector<HTMLElement>("[data-accessibility-role='button']");
    let activation: MouseEvent | undefined;
    button?.addEventListener("click", (event) => {
      activation = event;
    });
    await act(async () => {
      button?.click();
    });
    expect(activation?.defaultPrevented).toBe(true);
    expect(container.querySelector("rn-stub")).not.toBeNull();
    expect(container.querySelector("[data-accessibility-role='button']")).toBeNull();
    expect(linking.openURL).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps an image inside a rejected link as text when automatic loading is on", () => {
    const html = renderToStaticMarkup(
      <RemoteImagesContext.Provider value={true}>
        <ChatMarkdown>
          {
            "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
          }
        </ChatMarkdown>
      </RemoteImagesContext.Provider>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`data-color="${darkTokens.foreground}">Open</rn-text>`);
    expect(html).toContain(`data-color="${darkTokens.foreground}">File</rn-text>`);
  });

  it("shows an image inside a rejected link as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {
          "[![Open](https://example.test/visit)](javascript:alert(1)) [![File](https://example.test/file)](data:text/html,hi)"
        }
      </ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-stub");
    expect(html).not.toContain("<rn-pressable");
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(`data-color="${darkTokens.foreground}">Open</rn-text>`);
    expect(html).toContain(`data-color="${darkTokens.foreground}">File</rn-text>`);
  });

  it("shows mailto and tel image sources as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"![Contact](mailto:user@example.test) ![Call](tel:+15551212)"}</ChatMarkdown>,
    );
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("tel:");
    expect(html).toContain("Contact");
    expect(html).toContain("Call");
  });

  it("shows an image-only link with an unopenable destination as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"[![build](https://badge.example.test/b.svg)](/run)"}</ChatMarkdown>,
    );
    expect(html).not.toContain("<rn-pressable");
    expect(html).not.toContain("data-accessibility-role");
    expect(html).not.toContain("data-text-decoration-line");
    expect(html).not.toContain("badge.example.test");
    expect(html).toContain("build");
    // The label sits outside any text node, so it must carry the body color itself.
    expect(html).toContain(`data-color="${darkTokens.foreground}">build</rn-text>`);
  });

  it("renders embedded image data inline", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"![dot](data:image/png;base64,iVBORw0KGgo=)"}</ChatMarkdown>,
    );
    // The image component is a stub under test; a link would mean it fell back.
    expect(html).toContain("<rn-stub");
    expect(html).not.toContain("data-accessibility-role");
  });
});
