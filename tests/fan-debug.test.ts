import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapshotFromRawElements } from "../src/adapter/snapshot";
import { idSource, plan } from "../src/authoring/ops";

describe("fan debug", () => {
  it("dumps nudge moves", () => {
    (globalThis as { __nudgeDebug?: unknown[] }).__nudgeDebug = [];
    const snap = snapshotFromRawElements([] as never);
    const ops: any[] = [
      { op: "define_kind", kind: "svc", shape: "rectangle" },
      { op: "add_frame", ref: "$f", name: "Hub" },
      { op: "add_node", ref: "$hub", label: "Hub", kind: "svc", frame: "$f", intents: ["x"] },
    ];
    for (let i = 0; i < 6; i++) {
      ops.push({ op: "add_node", ref: `$t${i}`, label: `Target ${i}`, kind: "svc", frame: "$f", intents: ["x"] });
      ops.push({ op: "add_edge", from: "$hub", to: `$t${i}`, label: `call ${i}` });
    }
    for (let i = 0; i < 2; i++) {
      ops.push({ op: "add_node", ref: `$u${i}`, label: `Deep ${i}`, kind: "svc", frame: "$f", intents: ["x"] });
      ops.push({ op: "add_edge", from: `$t${i}`, to: `$u${i}`, label: `next ${i}` });
    }
    ops.push({ op: "add_edge", from: "$t5", to: "$hub", label: "report back" });
    plan(ops, snap, idSource(3));
    writeFileSync("/tmp/fan-moves.json", JSON.stringify((globalThis as { __nudgeDebug?: unknown[] }).__nudgeDebug, null, 1));
    expect(true).toBe(true);
  });
});
