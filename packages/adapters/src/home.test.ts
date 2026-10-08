import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-home-"));
  dirs.push(root);
  const store = new LocalAgentHomeStore(root);
  const home = store.pathFor("bot-1");
  await mkdir(home, { recursive: true });
  return { root, store, home };
}

describe("LocalAgentHomeStore path containment", () => {
  it("keeps revision metadata external without reserving a workspace file name", async () => {
    const { root, store } = await fixture();
    const source = path.join(root, "checkpoint-source");
    await mkdir(source);
    await writeFile(path.join(source, "result.txt"), "durable");
    await writeFile(path.join(source, ".revision"), "belongs to the user");

    const revision = await store.commit("bot-1", source, context);
    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);

    expect(revision).toMatch(/^rev-/);
    expect(store.describe().capabilities.revisions).toBe(false);
    expect(exported.sort()).toEqual([".revision", "result.txt"]);
  });

  it("rejects lexical traversal and sibling-prefix paths", async () => {
    const { store } = await fixture();
    await expect(store.readFile("bot-1", "../../homes-other/secret", context)).rejects.toThrow(
      /escapes|invalid/i,
    );
  });

  it("rejects oversized reads before loading their contents", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "large.txt"), "12345");

    await expect(store.readFile("bot-1", "large.txt", context, { maxBytes: 4 })).rejects.toThrow(
      /exceeds 4 bytes/,
    );
  });

  it("allows symlinks whose resolved target stays inside the bot home", async () => {
    const { store, home } = await fixture();
    await writeFile(path.join(home, "target.txt"), "before");
    await symlink("target.txt", path.join(home, "link.txt"));

    expect(await store.readFile("bot-1", "link.txt", context)).toBe("before");
    await store.writeFile("bot-1", "link.txt", "after", context);
    expect(await readFile(path.join(home, "target.txt"), "utf8")).toBe("after");
  });

  it("allows directory symlinks that remain inside the bot home", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "target-dir"));
    await symlink(path.join(home, "target-dir"), path.join(home, "linked-dir"), "junction");

    await store.writeFile("bot-1", "linked-dir/result.txt", "safe", context);
    expect(await readFile(path.join(home, "target-dir", "result.txt"), "utf8")).toBe("safe");
    expect(await store.list("bot-1", "linked-dir", context)).toEqual([
      { path: "linked-dir/result.txt", kind: "file", size: 4 },
    ]);
  });

  it("rejects reads and writes through symlinks outside the bot home", async () => {
    const { root, store, home } = await fixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(home, "escape.txt"));

    await expect(store.readFile("bot-1", "escape.txt", context)).rejects.toThrow(/escapes/i);
    await expect(store.writeFile("bot-1", "escape.txt", "changed", context)).rejects.toThrow(
      /escapes/i,
    );
    expect(await readFile(outside, "utf8")).toBe("secret");
  });

  it("does not create directories through an external symlink", async () => {
    const { root, store, home } = await fixture();
    const outside = path.join(root, "outside-dir");
    await mkdir(outside);
    await symlink(outside, path.join(home, "escape-dir"), "junction");

    await expect(
      store.writeFile("bot-1", "escape-dir/new/result.txt", "changed", context),
    ).rejects.toThrow(/escapes/i);
    await expect(readFile(path.join(outside, "new", "result.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("hides external symlinks from listings and exports", async () => {
    const { root, store, home } = await fixture();
    await writeFile(path.join(home, "safe.txt"), "safe");
    await symlink(path.join(root, "outside"), path.join(home, "external"));
    await writeFile(path.join(root, "outside"), "secret");

    expect(await store.list("bot-1", "", context)).toEqual([
      { path: "safe.txt", kind: "file", size: 4 },
    ]);
    const exported = [];
    for await (const file of store.exportHome("bot-1", context)) exported.push(file.path);
    expect(exported).toEqual(["safe.txt"]);
  });

  it("exports a directory with containment checked against the directory itself", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "bots/bot-a/notes"), { recursive: true });
    await mkdir(path.join(home, "bots/bot-b"), { recursive: true });
    await writeFile(path.join(home, "bots/bot-a/notes/result.txt"), "mine");
    await writeFile(path.join(home, "bots/bot-b/secret.txt"), "other");
    await symlink("../bot-b", path.join(home, "bots/bot-a/peer-dir"), "junction");
    await symlink("../bot-b/secret.txt", path.join(home, "bots/bot-a/peer-file"));
    await symlink("bot-b", path.join(home, "bots/bot-c"), "junction");
    await symlink("notes/result.txt", path.join(home, "bots/bot-a/latest.txt"));
    const exported = async (directory: string) => {
      const files = [];
      for await (const file of store.exportHome("bot-1", context, { directory }))
        files.push(file.path);
      return files;
    };

    expect((await exported("bots/bot-a")).sort()).toEqual(["latest.txt", "notes/result.txt"]);
    expect(await exported("bots/bot-c")).toEqual([]);
    expect(await exported("bots/missing")).toEqual([]);
    await expect(exported("../outside")).rejects.toThrow(/escapes/i);
  });

  it("skips hidden top-level entries, also behind visible links", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, ".config"), { recursive: true });
    await mkdir(path.join(home, "project"), { recursive: true });
    await writeFile(path.join(home, ".bash_history"), "history");
    await writeFile(path.join(home, ".config/token"), "token");
    await writeFile(path.join(home, "project/.gitignore"), "dist");
    await symlink(".bash_history", path.join(home, "history.txt"));
    await symlink(".config/token", path.join(home, "token.txt"));
    await symlink(".config", path.join(home, "config"), "junction");
    await symlink(".gitignore", path.join(home, "project/ignore.txt"));

    const files = [];
    for await (const file of store.exportHome("bot-1", context, { skipHidden: true })) {
      files.push(file.path);
    }
    expect(files.sort()).toEqual(["project/.gitignore", "project/ignore.txt"]);
  });

  it("skips hidden top-level links to visible entries without hiding their targets", async () => {
    const { store, home } = await fixture();
    await mkdir(path.join(home, "settings"), { recursive: true });
    await writeFile(path.join(home, "settings/theme.txt"), "dark");
    await symlink("settings", path.join(home, ".config"), "junction");
    await symlink("settings/theme.txt", path.join(home, ".theme"));

    const files = [];
    for await (const file of store.exportHome("bot-1", context, { skipHidden: true })) {
      files.push(file.path);
    }
    expect(files).toEqual(["settings/theme.txt"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails an export whose directory cannot be read instead of returning nothing",
    async () => {
      const { store, home } = await fixture();
      await mkdir(path.join(home, "bots/bot-a"), { recursive: true });
      await chmod(path.join(home, "bots"), 0o000);
      try {
        const files = store.exportHome("bot-1", context, { directory: "bots/bot-a" });
        await expect(files[Symbol.asyncIterator]().next()).rejects.toMatchObject({
          code: "EACCES",
        });
      } finally {
        await chmod(path.join(home, "bots"), 0o755);
      }
    },
  );

  it("exports and copies internal links, bytes, empty directories, and file modes", async () => {
    const { root, store, home } = await fixture();
    const bytes = Buffer.from([0, 255, 127, 10]);
    await mkdir(path.join(home, "nested/empty"), { recursive: true });
    await writeFile(path.join(home, "nested/run"), bytes);
    await chmod(path.join(home, "nested/run"), 0o750);
    await symlink("nested/run", path.join(home, "linked"));
    await symlink(home, path.join(home, "nested/loop"), "junction");

    const files = [];
    for await (const file of store.exportHome("bot-1", context)) files.push(file);
    expect(files.map((file) => file.path).sort()).toEqual(["linked", "nested/run"]);
    for (const file of files) {
      expect(Buffer.from(file.content)).toEqual(bytes);
      if (process.platform !== "win32") expect(file.executable).toBe(true);
    }
    const dest = path.join(root, "checkout");
    await store.checkout("bot-1", dest, context);
    expect(await readFile(path.join(dest, "linked"))).toEqual(bytes);
    expect((await stat(path.join(dest, "nested/empty"))).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(path.join(dest, "nested/run"))).mode & 0o777).toBe(0o750);
    }
    await store.commit("bot-2", dest, context);
    expect(await readFile(path.join(store.pathFor("bot-2"), "nested/run"))).toEqual(bytes);
  });
});
