import type { Actor } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import type { ThreadTarget } from "../thread-target.js";
import { releaseComputerControl } from "./computer.js";
import { takeoverReleaser } from "./threads.js";

vi.mock("./computer.js", () => ({ releaseComputerControl: vi.fn().mockResolvedValue(undefined) }));

const actor = { spaceId: "space-1", userId: "user-1" } as Actor;

describe("takeoverReleaser", () => {
  const findUnique = vi.fn();
  const deps = { prisma: { run: { findUnique } } } as unknown as RouterDeps;

  beforeEach(() => {
    findUnique.mockReset();
    vi.mocked(releaseComputerControl).mockReset().mockResolvedValue(undefined);
  });

  it("hands the screen back to the bot of a direct chat", async () => {
    const target = { kind: "bot", botId: "bot-1" } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-1");
    expect(releaseComputerControl).toHaveBeenCalledWith(deps, actor, "bot-1", "done", "run-1");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("hands the screen back to the group member whose run the reply steers", async () => {
    findUnique.mockResolvedValue({ botId: "bot-2" });
    const target = { kind: "group", memberBotIds: ["bot-1", "bot-2"] } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-2");
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-2", spaceId: "space-1" },
      select: { botId: true },
    });
    expect(releaseComputerControl).toHaveBeenCalledWith(deps, actor, "bot-2", "done", "run-2");
  });

  it("releases nothing when the run is gone", async () => {
    findUnique.mockResolvedValue(null);
    const target = { kind: "group", memberBotIds: ["bot-1"] } as ThreadTarget;
    await takeoverReleaser(deps, actor, target)("run-3");
    expect(releaseComputerControl).not.toHaveBeenCalled();
  });

  it("continues after a group run lookup fails", async () => {
    findUnique.mockRejectedValue(new Error("lookup failed"));
    const target = { kind: "group", memberBotIds: ["bot-1"] } as ThreadTarget;
    await expect(takeoverReleaser(deps, actor, target)("run-1")).resolves.toBeUndefined();
    expect(releaseComputerControl).not.toHaveBeenCalled();
  });

  it.each(["bot", "group"] as const)("continues after a %s release fails", async (kind) => {
    findUnique.mockResolvedValue({ botId: "bot-1" });
    vi.mocked(releaseComputerControl).mockRejectedValue(new Error("release failed"));
    const target =
      kind === "bot"
        ? ({ kind, botId: "bot-1" } as ThreadTarget)
        : ({ kind, memberBotIds: ["bot-1"] } as ThreadTarget);
    await expect(takeoverReleaser(deps, actor, target)("run-1")).resolves.toBeUndefined();
    expect(releaseComputerControl).toHaveBeenCalledWith(deps, actor, "bot-1", "done", "run-1");
  });
});
