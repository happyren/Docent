/**
 * Portfolio store integration (S12, D17): the real server process on an
 * ephemeral port with a temp data dir — CRUD round-trips, the on-disk
 * file-tree shape, name validation (the traversal guard), and the
 * .excalidraw-only write gate.
 *
 * A scene's name is a path (D92), so the same round-trips run nested: the
 * directories a path implies are created by a PUT and pruned by the DELETE
 * that empties them, and a flat name is simply a path of one segment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;
const SCENE = JSON.stringify({ type: "excalidraw", version: 2, elements: [] });

/** The one sentence a scene path is refused with (D92), to the byte. */
const SCENE_PATH_MESSAGE =
  "invalid scene path — up to 8 folders of letters, digits, spaces, - or _ " +
  "(max 64 each, no leading symbol)";

const sceneUrl = (project: string, scene: string) =>
  `${BASE}/api/projects/${project}/scenes/${encodeURIComponent(scene)}`;
const putScene = (project: string, scene: string, body = SCENE) =>
  fetch(sceneUrl(project, scene), { method: "PUT", body });
const listNames = async (project: string) =>
  (
    (await (await fetch(`${BASE}/api/projects/${project}/scenes`)).json()) as {
      name: string;
    }[]
  ).map((scene) => scene.name);

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

  it("puts a scene at a path, creating the folders it implies (D92)", async () => {
    expect((await fetch(`${BASE}/api/projects/tree`, { method: "PUT" })).status).toBe(201);

    // The whole path travels in the one URL segment, encoded — the routes have
    // the shape they always had.
    const put = await putScene("tree", "checkout/api/v2");
    expect(put.status, await put.clone().text()).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    // On disk it is what the path says: nested directories, one plain file.
    expect(
      await readFile(
        path.join(dataDir, "tree", "checkout", "api", "v2.excalidraw"),
        "utf8",
      ),
    ).toBe(SCENE);

    // …and it opens by the same path.
    const loaded = await fetch(sceneUrl("tree", "checkout/api/v2"));
    expect(loaded.status).toBe(200);
    expect(await loaded.text()).toBe(SCENE);

    // The project's count is the whole subtree's, not its top directory's.
    const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as {
      id: string;
      scenes: number;
    }[];
    expect(projects.find((project) => project.id === "tree")?.scenes).toBe(1);
  });

  it("lists a project's scenes recursively, folders first (D92)", async () => {
    for (const scene of [
      "zebra",
      "checkout/api/v1",
      "checkout/refunds",
      "billing/invoices",
      "alpha",
    ]) {
      expect((await putScene("tree", scene)).status, scene).toBe(200);
    }
    // Segment by segment: a directory's contents stay together and lead the
    // flat names beside them, siblings in the order they always had.
    expect(await listNames("tree")).toEqual([
      "billing/invoices",
      "checkout/api/v1",
      "checkout/api/v2",
      "checkout/refunds",
      "alpha",
      "zebra",
    ]);
  });

  it("prunes the folders a delete empties, and never the project (D92)", async () => {
    expect(
      (await fetch(sceneUrl("tree", "checkout/api/v1"), { method: "DELETE" })).status,
    ).toBe(200);
    // Its folder still holds a scene, so it stays.
    expect(await readdir(path.join(dataDir, "tree", "checkout", "api"))).toEqual([
      "v2.excalidraw",
    ]);

    expect(
      (await fetch(sceneUrl("tree", "checkout/api/v2"), { method: "DELETE" })).status,
    ).toBe(200);
    // Emptied, so gone — ancestor by ancestor, while the ancestor is empty.
    await expect(readdir(path.join(dataDir, "tree", "checkout", "api"))).rejects.toThrow();
    expect(await readdir(path.join(dataDir, "tree", "checkout"))).toEqual([
      "refunds.excalidraw",
    ]);

    expect(
      (await fetch(sceneUrl("tree", "checkout/refunds"), { method: "DELETE" })).status,
    ).toBe(200);
    await expect(readdir(path.join(dataDir, "tree", "checkout"))).rejects.toThrow();
    expect(await listNames("tree")).toEqual(["billing/invoices", "alpha", "zebra"]);

    // …and the last scene of the last folder takes the folder, never the
    // project: an empty project is still a project.
    for (const scene of ["billing/invoices", "alpha", "zebra"]) {
      expect((await fetch(sceneUrl("tree", scene), { method: "DELETE" })).status).toBe(200);
    }
    expect((await stat(path.join(dataDir, "tree"))).isDirectory()).toBe(true);
    expect(await readdir(path.join(dataDir, "tree"))).toEqual([]);
    expect(await listNames("tree")).toEqual([]);
    expect((await fetch(`${BASE}/api/projects/tree`, { method: "DELETE" })).status).toBe(200);
  });

  it("refuses a scene path it could not address, in one sentence (D92)", async () => {
    for (const scene of [
      // Nine segments: one deeper than a path goes.
      "a/b/c/d/e/f/g/h/i",
      // The store's own exception is reserved at every level, in any case.
      ".docent/plan",
      "work/.docent/plan",
      "work/.DOCENT/plan",
      // An empty segment, a leading symbol, and a segment over 64.
      "a//b",
      "a/",
      "/a",
      "a/-flag",
      `a/${"x".repeat(65)}`,
      "a/../escape",
    ]) {
      const res = await putScene("work", scene);
      expect(res.status, scene).toBe(400);
      expect(await res.json(), scene).toEqual({ error: SCENE_PATH_MESSAGE });
    }
    // Eight is the depth, and it is allowed.
    expect((await putScene("work", "a/b/c/d/e/f/g/h")).status).toBe(200);
    expect(
      (await fetch(sceneUrl("work", "a/b/c/d/e/f/g/h"), { method: "DELETE" })).status,
    ).toBe(200);
  });

  it("keeps project names to one segment, with the message they always had", async () => {
    const res = await fetch(
      `${BASE}/api/projects/${encodeURIComponent("work/nested")}`,
      { method: "PUT" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "invalid project name — use letters, digits, spaces, - or _ (max 64, no leading symbol)",
    });
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
