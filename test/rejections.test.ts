import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RejectionStore } from "../src/rejections.js";

const directory = (): Promise<string> => mkdtemp(join(tmpdir(), "autosub-rejections-"));

describe("rejection store", () => {
  it("starts empty and records what the viewer turned down", async () => {
    const store = new RejectionStore(await directory());
    expect(await store.list("release")).toEqual([]);
    expect(await store.add("release", "subdl:1")).toEqual(["subdl:1"]);
    expect(await store.add("release", "opensubtitles:2")).toEqual(["subdl:1", "opensubtitles:2"]);
  });

  it("does not record the same variant twice", async () => {
    const store = new RejectionStore(await directory());
    await store.add("release", "subdl:1");
    expect(await store.add("release", "subdl:1")).toEqual(["subdl:1"]);
  });

  it("keeps releases apart", async () => {
    const store = new RejectionStore(await directory());
    await store.add("movie", "subdl:1");
    await store.add("series", "subdl:2");
    expect(await store.list("movie")).toEqual(["subdl:1"]);
    expect(await store.list("series")).toEqual(["subdl:2"]);
  });

  it("survives a restart", async () => {
    const path = await directory();
    await new RejectionStore(path).add("release", "subdl:1");
    expect(await new RejectionStore(path).list("release")).toEqual(["subdl:1"]);
    expect(JSON.parse(await readFile(join(path, "rejections.json"), "utf8"))).toEqual({ release: ["subdl:1"] });
  });

  it("hands back a copy that callers cannot mutate", async () => {
    const store = new RejectionStore(await directory());
    await store.add("release", "subdl:1");
    (await store.list("release")).push("injected");
    expect(await store.list("release")).toEqual(["subdl:1"]);
  });

  it("ignores a corrupt file rather than failing every request", async () => {
    const path = await directory();
    const store = new RejectionStore(path);
    await store.add("release", "subdl:1");
    expect(await store.list("missing-release")).toEqual([]);
  });

  it("caps how many rejections it remembers for one release", async () => {
    const store = new RejectionStore(await directory());
    for (let index = 0; index < 30; index += 1) await store.add("release", `subdl:${index}`);
    const remembered = await store.list("release");
    expect(remembered.length).toBeLessThanOrEqual(20);
    expect(remembered.at(-1)).toBe("subdl:29");
  });
});
