/**
 * Portfolio store integration (S12, D17): the real server process on an
 * ephemeral port with a temp data dir — CRUD round-trips, the on-disk
 * file-tree shape, name validation (the traversal guard), and the
 * .excalidraw-only write gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;
const SCENE = JSON.stringify({ type: "excalidraw", version: 2, elements: [] });

let server: ChildProcess;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "docent-store-"));
  server = spawn("node", [path.resolve("server/docent-store.mjs")], {
    env: {
      ...process.env,
      DOCENT_STORE_PORT: String(PORT),
      DOCENT_DATA: dataDir,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("store did not start")), 5000);
    server.stdout?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
    server.on("exit", () => reject(new Error("store exited early")));
  });
});

afterAll(async () => {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
});

describe("portfolio store", () => {
  it("reports health", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("starts empty", async () => {
    const res = await fetch(`${BASE}/api/projects`);
    expect(await res.json()).toEqual([]);
  });

  it("creates projects and scenes as a plain file tree (D17)", async () => {
    const create = await fetch(`${BASE}/api/projects/work`, { method: "PUT" });
    expect(create.status).toBe(201);

    const put = await fetch(`${BASE}/api/projects/work/scenes/checkout`, {
      method: "PUT",
      body: SCENE,
    });
    expect(put.status).toBe(200);

    // The store adds no format of its own: the scene is a plain
    // .excalidraw file at <data>/<project>/<scene>.excalidraw.
    const onDisk = await readFile(
      path.join(dataDir, "work", "checkout.excalidraw"),
      "utf8",
    );
    expect(onDisk).toBe(SCENE);
    expect(await readdir(dataDir)).toEqual(["work"]);

    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as {
      id: string;
      scenes: number;
    }[];
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("work");
    expect(projects[0].scenes).toBe(1);

    const scenes = (await (
      await fetch(`${BASE}/api/projects/work/scenes`)
    ).json()) as { name: string }[];
    expect(scenes.map((s) => s.name)).toEqual(["checkout"]);

    const roundTrip = await fetch(`${BASE}/api/projects/work/scenes/checkout`);
    expect(await roundTrip.text()).toBe(SCENE);
  });

  it("rejects path-escaping and malformed names", async () => {
    // ".." is collapsed by URL normalization before it ever reaches the
    // route (404); the rest hit the name gate (400). Either way the name
    // never touches the filesystem.
    for (const name of ["..", "a/b", ".hidden", "-flag", "a".repeat(65)]) {
      const res = await fetch(
        `${BASE}/api/projects/${encodeURIComponent(name)}`,
        { method: "PUT" },
      );
      expect([400, 404], name).toContain(res.status);
    }
    const res = await fetch(
      `${BASE}/api/projects/work/scenes/${encodeURIComponent("../escape")}`,
      { method: "PUT", body: SCENE },
    );
    expect(res.status).toBe(400);
  });

  it("only persists .excalidraw scenes (D17)", async () => {
    const notJson = await fetch(`${BASE}/api/projects/work/scenes/bad`, {
      method: "PUT",
      body: "not json",
    });
    expect(notJson.status).toBe(400);

    const wrongType = await fetch(`${BASE}/api/projects/work/scenes/bad`, {
      method: "PUT",
      body: JSON.stringify({ type: "other" }),
    });
    expect(wrongType.status).toBe(400);
  });

  it("404s on missing projects and scenes", async () => {
    expect((await fetch(`${BASE}/api/projects/nope/scenes`)).status).toBe(404);
    expect(
      (await fetch(`${BASE}/api/projects/work/scenes/nope`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${BASE}/api/projects/nope/scenes/x`, {
          method: "PUT",
          body: SCENE,
        })
      ).status,
    ).toBe(404);
  });

  it("deletes scenes and projects", async () => {
    const delScene = await fetch(`${BASE}/api/projects/work/scenes/checkout`, {
      method: "DELETE",
    });
    expect(delScene.status).toBe(200);
    expect(
      (await (await fetch(`${BASE}/api/projects/work/scenes`)).json()) as [],
    ).toEqual([]);

    const delProject = await fetch(`${BASE}/api/projects/work`, {
      method: "DELETE",
    });
    expect(delProject.status).toBe(200);
    expect(await (await fetch(`${BASE}/api/projects`)).json()).toEqual([]);
  });
});
