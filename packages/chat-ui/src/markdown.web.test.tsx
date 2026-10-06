// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

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
});
