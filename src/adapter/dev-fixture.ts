/**
 * Dev-only fixture builder — generates `public/samples/demo.excalidraw` via
 * Excalidraw's own skeleton converter so the sample is guaranteed canonical.
 * Lives inside the adapter boundary (B1). Never imported by the app; invoke
 * from the browser console in dev:
 *
 *   const m = await import("/src/adapter/dev-fixture.ts");
 *   copy(m.buildDemoSceneJSON());
 */
import {
  convertToExcalidrawElements,
  restoreAppState,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

const LEGEND = [
  { attr: "strokeStyle", value: "dashed", key: "channel", meaning: "async" },
  { attr: "backgroundColor", value: "#a5d8ff", key: "kind", meaning: "datastore" },
  { attr: "backgroundColor", value: "#ffec99", key: "tag", meaning: "edge" },
];

export function buildDemoSceneJSON(): string {
  const elements = convertToExcalidrawElements(
    [
      {
        type: "text",
        id: "legend_carrier",
        text: `Legend\n${LEGEND.map(
          (r) => `${r.attr} ${r.value} → ${r.key}: ${r.meaning}`,
        ).join("\n")}`,
        x: 60,
        y: 10,
        fontSize: 14,
        locked: true,
        customData: { docent: { legend: LEGEND } },
      },
      {
        type: "rectangle",
        id: "n_client",
        x: 60,
        y: 140,
        width: 160,
        height: 70,
        label: { text: "Client" },
      },
      {
        type: "rectangle",
        id: "n_gateway",
        x: 340,
        y: 140,
        width: 180,
        height: 70,
        backgroundColor: "#ffec99",
        label: { text: "API Gateway" },
        customData: {
          docent: {
            detail: { frameId: "f_gw_detail" },
            tags: ["hot-path"],
            note: "rate-limited at edge",
          },
        },
      },
      {
        type: "rectangle",
        id: "n_auth",
        x: 700,
        y: 140,
        width: 180,
        height: 70,
        label: { text: "Auth Service" },
      },
      {
        type: "ellipse",
        id: "n_db",
        x: 710,
        y: 340,
        width: 160,
        height: 80,
        backgroundColor: "#a5d8ff",
        label: { text: "Postgres" },
        customData: {
          docent: { note: "single writer; replicas serve reads" },
        },
      },
      {
        type: "arrow",
        id: "e_req",
        x: 230,
        y: 175,
        width: 100,
        height: 0,
        label: { text: "HTTPS" },
        start: { id: "n_client" },
        end: { id: "n_gateway" },
      },
      {
        type: "arrow",
        id: "e_verify",
        x: 530,
        y: 175,
        width: 160,
        height: 0,
        label: { text: "verify JWT" },
        start: { id: "n_gateway" },
        end: { id: "n_auth" },
      },
      {
        type: "arrow",
        id: "e_query",
        x: 790,
        y: 220,
        width: 0,
        height: 110,
        strokeStyle: "dashed",
        start: { id: "n_auth" },
        end: { id: "n_db" },
      },
      {
        type: "arrow",
        id: "e_session",
        x: 800,
        y: 330,
        width: 5,
        height: 110,
        points: [
          [0, 0],
          [-5, -110],
        ],
        strokeStyle: "dashed",
        label: { text: "session reads", fontSize: 14 },
      },
      {
        type: "frame",
        id: "f_ingress",
        name: "01 Ingress",
        children: ["n_client", "n_gateway"],
        customData: {
          docent: {
            narrative:
              "All external traffic lands here; the gateway terminates TLS and rate-limits before anything reaches core.",
          },
        },
      },
      {
        type: "frame",
        id: "f_core",
        name: "02 Core",
        children: ["n_auth", "n_db"],
        customData: {
          docent: {
            narrative:
              "Auth verifies JWTs and keeps session state in Postgres — the only writer; replicas serve reads.",
          },
        },
      },
      // Tier 2 — inner mechanism of the API Gateway (drill target of n_gateway)
      {
        type: "rectangle",
        id: "n_tls",
        x: 80,
        y: 660,
        width: 180,
        height: 70,
        label: { text: "TLS Termination" },
      },
      {
        type: "rectangle",
        id: "n_ratelimit",
        x: 360,
        y: 660,
        width: 170,
        height: 70,
        label: { text: "Rate Limiter" },
      },
      {
        type: "rectangle",
        id: "n_router",
        x: 630,
        y: 660,
        width: 150,
        height: 70,
        backgroundColor: "#d0bfff",
        label: { text: "Router" },
        customData: { docent: { detail: { frameId: "f_router_detail" } } },
      },
      {
        type: "arrow",
        id: "e_gw1",
        x: 270,
        y: 695,
        width: 80,
        height: 0,
        start: { id: "n_tls" },
        end: { id: "n_ratelimit" },
      },
      {
        type: "arrow",
        id: "e_gw2",
        x: 540,
        y: 695,
        width: 80,
        height: 0,
        start: { id: "n_ratelimit" },
        end: { id: "n_router" },
      },
      {
        type: "frame",
        id: "f_gw_detail",
        name: "API Gateway — detail",
        children: ["n_tls", "n_ratelimit", "n_router", "e_gw1", "e_gw2"],
        customData: {
          docent: {
            narrative:
              "Inside the gateway: TLS termination first, then rate limiting, then routing.",
          },
        },
      },
      // Tier 3 — inner mechanism of the Router (drill target of n_router)
      {
        type: "rectangle",
        id: "n_routes",
        x: 80,
        y: 1180,
        width: 180,
        height: 70,
        label: { text: "Route Table" },
      },
      {
        type: "rectangle",
        id: "n_lb",
        x: 380,
        y: 1180,
        width: 210,
        height: 70,
        label: { text: "Least-Conn Picker" },
      },
      {
        type: "arrow",
        id: "e_rt1",
        x: 270,
        y: 1215,
        width: 100,
        height: 0,
        label: { text: "match path" },
        start: { id: "n_routes" },
        end: { id: "n_lb" },
      },
      {
        type: "frame",
        id: "f_router_detail",
        name: "Router — detail",
        children: ["n_routes", "n_lb", "e_rt1"],
        customData: {
          docent: {
            narrative:
              "The router matches the request path against the route table and picks the least-loaded backend.",
          },
        },
      },
    ],
    { regenerateIds: false },
  );

  return serializeAsJSON(
    elements,
    restoreAppState({ viewBackgroundColor: "#ffffff" }, null),
    {},
    "local",
  );
}
