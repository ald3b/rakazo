import { describe, expect, it } from "vitest";
import { scrollDirection, scrollPoint } from "./computer-input.js";

describe("scrollPoint", () => {
  it("keeps the point a scroll was made at, in whole screen pixels", () => {
    expect(scrollPoint({ direction: "down", amount: 2, x: 600.4, y: 420 })).toEqual({
      x: 600,
      y: 420,
    });
  });

  it("drops a missing, partial or invalid point, so the wheel turns where the pointer is", () => {
    expect(scrollPoint({ direction: "down" })).toEqual({});
    expect(scrollPoint({ x: 600 })).toEqual({});
    expect(scrollPoint({ x: "left", y: 420 })).toEqual({});
    expect(scrollPoint({ x: -5, y: 420 })).toEqual({});
    expect(scrollPoint({ x: Number.POSITIVE_INFINITY, y: 420 })).toEqual({});
  });
});

describe("scrollDirection", () => {
  it("scrolls up, down, left or right, and down for anything else", () => {
    expect(["up", "down", "left", "right", "sideways", undefined].map(scrollDirection)).toEqual([
      "up",
      "down",
      "left",
      "right",
      "down",
      "down",
    ]);
  });
});
