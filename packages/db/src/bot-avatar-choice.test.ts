import { BOT_COLORS } from "@rakazo/contracts";
import { organicAvatarFamily, organicAvatarLook } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { BOT_ID_ATTEMPTS, chooseBotAvatar, pickLeastUsed } from "./bot-avatar-choice.js";

/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Existing bot ids, one per requested organic family. */
function idsForFamilies(families: number[]) {
  return families.map((family) => {
    for (let index = 0; ; index++) {
      const id = `existing-${family}-${index}`;
      if (organicAvatarFamily(id) === family) return id;
    }
  });
}

describe("pickLeastUsed", () => {
  it("only picks among the least-used options, and reaches each of them", () => {
    const random = seeded(1);
    const picks = new Set(
      Array.from({ length: 200 }, () =>
        pickLeastUsed(["a", "b", "c", "d"], ["a", "b", "b"], random),
      ),
    );
    expect(picks).toEqual(new Set(["c", "d"]));
  });
});

describe("chooseBotAvatar", () => {
  it("gives a new bot the organic family and colour the user's bots use least", () => {
    const existing = idsForFamilies([0, 1, 2, 3, 4, 5, 6, 7, 8]).map((id, index) => ({
      id,
      color: BOT_COLORS[index % 6]!,
    }));
    for (let seed = 1; seed <= 20; seed++) {
      const chosen = chooseBotAvatar(existing, undefined, { random: seeded(seed), now: 0 });
      expect(organicAvatarFamily(chosen.id)).toBe(9);
      expect(chosen.color).toBe(BOT_COLORS[6]);
      expect(chosen.id).toMatch(/^c[a-z0-9]{24}$/);
    }
  });

  it("treats the two round families as one look", () => {
    // Family 8 is the only unused family, but it is the same round look as family 2.
    const existing = idsForFamilies([0, 1, 2, 3, 4, 5, 6, 7, 9]).map((id) => ({
      id,
      color: "#3EC5A8",
    }));
    const random = seeded(1);
    const looks = Array.from({ length: 20 }, () =>
      organicAvatarLook(organicAvatarFamily(chooseBotAvatar(existing, undefined, { random }).id)),
    );
    // Every look is used once, so the new bot is not pushed into a second round body.
    expect(looks.some((look) => look !== 2)).toBe(true);
  });

  it("breaks a colour tie away from colours already on the same look", () => {
    // The round look is least used; orange and blue are the least-used colours, and orange is
    // already on a round bot.
    const [round] = idsForFamilies([2]);
    const others = idsForFamilies([0, 1, 3, 4, 5, 6, 7, 9, 0, 1, 3, 4, 5, 6, 7, 9]);
    const spread = ["#3EC5A8", "#6A6BF5", "#9B5CF6", "#F2622A", "#D9508A"];
    const existing = [
      { id: round!, color: "#F5A03C" },
      { id: others[0]!, color: "#3B82F6" },
      ...others.slice(1).map((id, index) => ({ id, color: spread[index % spread.length]! })),
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const chosen = chooseBotAvatar(existing, undefined, { random: seeded(seed), now: 0 });
      expect(organicAvatarLook(organicAvatarFamily(chosen.id))).toBe(2);
      expect(chosen.color).toBe("#3B82F6");
    }
  });

  it("does not count bots that show a picture or an Avatar Studio shape", () => {
    const [shaped, pictured] = idsForFamilies([0, 0]);
    const others = idsForFamilies([1, 2, 3, 4, 5, 6, 7, 8, 9]).map((id) => ({
      id,
      color: "#3EC5A8",
    }));
    const chosen = chooseBotAvatar(
      [
        ...others,
        { id: shaped!, color: "#F5A03C::shape_2" },
        { id: pictured!, color: "data:image/png;base64,AAAA" },
      ],
      undefined,
      { random: seeded(3), now: 0 },
    );
    expect(organicAvatarFamily(chosen.id)).toBe(0);
    // The shaped bot's colour still counts; the picture has none.
    expect(chosen.color).not.toBe("#3EC5A8");
    expect(chosen.color).not.toBe("#F5A03C");
  });

  it("keeps a colour the caller chose", () => {
    expect(chooseBotAvatar([], "#123456", { random: seeded(4), now: 0 }).color).toBe("#123456");
  });

  it("settles for the last id after the attempt cap", () => {
    let calls = 0;
    // Always the same digits, so every try draws the same id.
    const random = () => {
      calls += 1;
      return 0;
    };
    const stuck = chooseBotAvatar([], undefined, { random, now: 0 });
    const family = organicAvatarFamily(stuck.id);
    // Family 0 is the only least-used pick a zero random can make; force a miss by using it up.
    const existing = idsForFamilies([family]).map((id) => ({ id, color: "#3EC5A8" }));
    calls = 0;
    const capped = chooseBotAvatar(existing, undefined, { random, now: 0 });
    expect(capped.id).toBe(stuck.id);
    expect(organicAvatarFamily(capped.id)).toBe(family);
    // One family pick, sixteen digits per try, one colour pick.
    expect(calls).toBe(1 + 16 * BOT_ID_ATTEMPTS + 1);
  });
});
