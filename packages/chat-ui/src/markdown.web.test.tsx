// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown, RemoteImagesContext } from "./markdown.web";

describe("web markdown remote images", () => {
  it("loads a remote image in place only after the reader asks", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const markdown = "![chart](https://images.example.test/tap.png)";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("img")).toBeNull();

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("chartimages.example.test");
    await act(async () => {
      button?.click();
    });
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://images.example.test/tap.png");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();

    // The reader's choice holds for the session, so a remounted bubble keeps the image.
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain(
      'src="https://images.example.test/tap.png"',
    );
  });

  it("shows a placeholder when a tapped image is replaced with another url", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (src: string) => {
      root.render(<ChatMarkdown>{`![chart](${src})`}</ChatMarkdown>);
    };
    await act(async () => {
      render("https://images.example.test/first.png");
    });
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://images.example.test/first.png",
    );

    await act(async () => {
      render("https://images.example.test/second.png");
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("button")?.textContent).toContain("images.example.test");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads an image inside an open link from its placeholder without following the link", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const markdown =
      "See [![build](https://badge.example.test/tap-linked.svg)](https://ci.example.test/tap-linked) now";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("tap-linked.svg");

    const link = container.querySelector("a");
    const button = link?.querySelector("button");
    expect(link?.getAttribute("href")).toBe("https://ci.example.test/tap-linked");
    expect(button?.textContent).toContain("build");
    expect(button?.textContent).toContain("badge.example.test");

    let activation: MouseEvent | undefined;
    button?.addEventListener("click", (event) => {
      activation = event;
    });
    const reachedWindow = vi.fn();
    window.addEventListener("click", reachedWindow);
    await act(async () => {
      button?.click();
    });
    window.removeEventListener("click", reachedWindow);

    expect(activation?.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled();
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("https://badge.example.test/tap-linked.svg");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector("button")).toBeNull();
    expect(link?.getAttribute("href")).toBe("https://ci.example.test/tap-linked");

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
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("example.test");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span>Open</span>");
    expect(html).toContain("<span>File</span>");
  });
});
