import { describe, expect, it } from "vitest";
import { jumpOffset, offscreenUnreads, visibleRange } from "./offscreen-unreads";

const read = { unread: 0, attention: 0 };
const unread = { unread: 1, attention: 0 };
const waiting = { unread: 0, attention: 1 };

describe("visibleRange", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ y: index * 100, height: 100 }));

  it("counts rows at least half inside the viewport, after the insets", () => {
    // The viewport shows 140..390: row 1 is 60% in, row 3 is 90% in, row 4 is under the edge.
    expect(visibleRange(rows, { top: 140, bottom: 390 })).toEqual({ first: 1, last: 3 });
    expect(visibleRange(rows, { top: 160, bottom: 340 })).toEqual({ first: 2, last: 2 });
  });

  it("has no range before any row is measured", () => {
    expect(visibleRange([], { top: 0, bottom: 500 })).toBeUndefined();
    expect(visibleRange([undefined, undefined], { top: 0, bottom: 500 })).toBeUndefined();
  });
});

describe("offscreenUnreads", () => {
  it("counts unread chats on each side and targets the nearest one", () => {
    const signals = [unread, read, unread, read, read, read, unread, unread];
    expect(offscreenUnreads(signals, { first: 3, last: 5 })).toEqual({
      above: { kind: "unread", count: 2, index: 2 },
      below: { kind: "unread", count: 2, index: 6 },
    });
  });

  it("ignores unread chats on screen and shows nothing when none are off it", () => {
    expect(offscreenUnreads([read, unread, read], { first: 0, last: 2 })).toEqual({});
  });

  it("lets a chat waiting on you outrank unread ones on that side", () => {
    const signals = [read, read, read, unread, waiting, unread];
    expect(offscreenUnreads(signals, { first: 0, last: 2 }).below).toEqual({
      kind: "attention",
      count: 1,
      index: 4,
    });
  });

  it("counts every chat a pinned strip holds", () => {
    expect(offscreenUnreads([{ unread: 2, attention: 0 }, read], { first: 1, last: 1 })).toEqual({
      above: { kind: "unread", count: 2, index: 0 },
    });
  });
});

describe("jumpOffset", () => {
  const metrics = {
    viewportHeight: 800,
    contentHeight: 3000,
    topInset: 100,
    bottomInset: 34,
    pillSpace: 50,
    isLast: false,
  };

  it("brings a row below to the top, under the upper pill", () => {
    expect(jumpOffset("below", { y: 1200, height: 80 }, metrics)).toBe(1050);
  });

  it("brings a row above to the bottom, over the lower pill", () => {
    expect(jumpOffset("above", { y: 1000, height: 80 }, metrics)).toBe(364);
  });

  it("lands the last row flush at the bottom and never scrolls past either end", () => {
    expect(jumpOffset("below", { y: 2920, height: 80 }, { ...metrics, isLast: true })).toBe(2234);
    expect(jumpOffset("above", { y: 0, height: 80 }, metrics)).toBe(-100);
    expect(jumpOffset("below", { y: 2900, height: 80 }, metrics)).toBe(2234);
  });
});
