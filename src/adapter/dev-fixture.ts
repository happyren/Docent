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
        y: 20460,
        width: 180,
        height: 70,
        label: { text: "TLS Termination" },
      },
      {
        type: "rectangle",
        id: "n_ratelimit",
        x: 360,
        y: 20460,
        width: 170,
        height: 70,
        label: { text: "Rate Limiter" },
      },
      {
        type: "rectangle",
        id: "n_router",
        x: 630,
        y: 20460,
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
        y: 20495,
        width: 80,
        height: 0,
        start: { id: "n_tls" },
        end: { id: "n_ratelimit" },
      },
      {
        type: "arrow",
        id: "e_gw2",
        x: 540,
        y: 20495,
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
        y: 40460,
        width: 180,
        height: 70,
        label: { text: "Route Table" },
      },
      {
        type: "rectangle",
        id: "n_lb",
        x: 380,
        y: 40460,
        width: 210,
        height: 70,
        label: { text: "Least-Conn Picker" },
      },
      {
        type: "arrow",
        id: "e_rt1",
        x: 270,
        y: 40495,
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

/** Q4 perf fixture: ~200 elements (rects + bound labels + arrows). */
export function buildPerfSceneJSON(): string {
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
  const COLS = 10;
  const ROWS = 9;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      skeletons!.push({
        type: "rectangle",
        id: `perf_${r}_${c}`,
        x: c * 220,
        y: r * 140,
        width: 160,
        height: 80,
        backgroundColor: (r + c) % 3 === 0 ? "#ffec99" : "transparent",
        label: { text: `svc ${r}.${c}`, fontSize: 16 },
      });
    }
  }
  // 20 bound arrows between horizontal neighbours on alternating rows.
  for (let i = 0; i < 20; i++) {
    const r = (i * 2) % ROWS;
    const c = i % (COLS - 1);
    skeletons!.push({
      type: "arrow",
      id: `perf_e_${i}`,
      x: c * 220 + 165,
      y: r * 140 + 40,
      width: 50,
      height: 0,
      points: [
        [0, 0],
        [50, 0],
      ],
      start: { id: `perf_${r}_${c}` },
      end: { id: `perf_${r}_${c + 1}` },
    });
  }
  const elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  return serializeAsJSON(
    elements,
    restoreAppState({ viewBackgroundColor: "#ffffff" }, null),
    {},
    "local",
  );
}

/** Q1 parity fixture: one arrow of each geometry class. */
export function buildArrowParitySceneJSON(): string {
  const elements = convertToExcalidrawElements(
    [
      { type: "rectangle", id: "p_a", x: 60, y: 60, width: 120, height: 60, label: { text: "A" } },
      { type: "rectangle", id: "p_b", x: 520, y: 60, width: 120, height: 60, label: { text: "B" } },
      { type: "rectangle", id: "p_c", x: 520, y: 340, width: 120, height: 60, label: { text: "C" } },
      { type: "rectangle", id: "p_d", x: 60, y: 340, width: 120, height: 60, label: { text: "D" } },
      {
        type: "arrow",
        id: "pe_straight",
        x: 190,
        y: 90,
        width: 320,
        height: 0,
        points: [
          [0, 0],
          [320, 0],
        ],
        start: { id: "p_a" },
        end: { id: "p_b" },
      },
      {
        type: "arrow",
        id: "pe_curved",
        x: 580,
        y: 130,
        width: 80,
        height: 200,
        points: [
          [0, 0],
          [70, 60],
          [-50, 130],
          [0, 200],
        ],
        roundness: { type: 2 },
        start: { id: "p_b" },
        end: { id: "p_c" },
      },
      {
        type: "arrow",
        id: "pe_elbow",
        x: 510,
        y: 370,
        width: 320,
        height: 0,
        points: [
          [0, 0],
          [-160, 0],
          [-160, -50],
          [-320, -50],
          [-320, 0],
        ],
        start: { id: "p_c" },
        end: { id: "p_d" },
      },
      {
        type: "arrow",
        id: "pe_vertical",
        x: 120,
        y: 330,
        width: 0,
        height: 200,
        points: [
          [0, 0],
          [0, -200],
        ],
        start: { id: "p_d" },
        end: { id: "p_a" },
      },
      // True elbowed-flag arrow: bound diagonal, routed at right angles.
      {
        type: "arrow",
        id: "pe_true_elbow",
        x: 190,
        y: 120,
        width: 330,
        height: 220,
        // Not in the skeleton's declared type but honored by the converter.
        ...({ elbowed: true } as Record<string, unknown>),
        points: [
          [0, 0],
          [330, 220],
        ],
        start: { id: "p_a" },
        end: { id: "p_c" },
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

/**
 * Comprehensive showcase: a realistic e-commerce platform exercising every
 * Docent capability — 4-frame Layer-1 story, three Layer-2 internals, two
 * Layer-3 diagrams, 6 legend rules, tags/notes, narratives on every frame,
 * straight/curved/elbow arrows, and one unbound (inferred) arrow.
 * Tier bands: L2 at y≈21k, L3 at y≈41k.
 */
export function buildShowcaseSceneJSON(): string {
  const SHOWCASE_LEGEND = [
    { attr: "strokeStyle", value: "dashed", key: "channel", meaning: "async" },
    { attr: "backgroundColor", value: "#a5d8ff", key: "kind", meaning: "datastore" },
    { attr: "backgroundColor", value: "#d0bfff", key: "kind", meaning: "queue" },
    { attr: "backgroundColor", value: "#b2f2bb", key: "tag", meaning: "async-worker" },
    { attr: "backgroundColor", value: "#ffec99", key: "tag", meaning: "edge" },
    { attr: "strokeColor", value: "#e03131", key: "tag", meaning: "hot-path" },
  ];
  const doc = (d: Record<string, unknown>) => ({ customData: { docent: d } });
  const elements = convertToExcalidrawElements(
    [
      {
        type: "text",
        id: "sc_legend",
        text: `Legend\n${SHOWCASE_LEGEND.map(
          (r) => `${r.attr} ${r.value} → ${r.key}: ${r.meaning}`,
        ).join("\n")}`,
        x: 0,
        y: -180,
        fontSize: 14,
        locked: true,
        ...doc({ legend: SHOWCASE_LEGEND }),
      },

      // ------------------------------------------------ 01 Edge
      { type: "rectangle", id: "n_user", x: 40, y: 80, width: 170, height: 70, label: { text: "Web / Mobile" }, ...doc({ note: "1.2M MAU; 60% mobile" }) },
      { type: "rectangle", id: "n_cdn", x: 40, y: 240, width: 170, height: 70, backgroundColor: "#ffec99", label: { text: "CDN" } },
      { type: "rectangle", id: "n_gw", x: 480, y: 150, width: 210, height: 90, backgroundColor: "#ffec99", strokeColor: "#e03131", label: { text: "API Gateway" }, ...doc({ detail: { frameId: "f_gw_d" }, note: "rate-limited: 10k rps burst" }) },
      { type: "arrow", id: "e_user_gw", x: 220, y: 185, width: 250, height: 10, strokeColor: "#e03131", label: { text: "HTTPS" }, start: { id: "n_user" }, end: { id: "n_gw" } },
      { type: "arrow", id: "e_user_cdn", x: 120, y: 160, width: 0, height: 70, label: { text: "assets", fontSize: 14 }, start: { id: "n_user" }, end: { id: "n_cdn" } },
      { type: "frame", id: "f_edge", name: "01 Edge", children: ["n_user", "n_cdn", "n_gw", "e_user_gw", "e_user_cdn"], ...doc({ narrative: "Everything starts here: users hit the CDN for static assets, and every API call passes the gateway — TLS, rate limits, routing — before touching a service." }) },

      // ------------------------------------------------ 02 Core Services
      { type: "rectangle", id: "n_auth", x: 1000, y: 60, width: 180, height: 70, label: { text: "Auth" }, ...doc({ note: "stateless JWT; sessions in Redis" }) },
      { type: "rectangle", id: "n_catalog", x: 1000, y: 300, width: 180, height: 70, label: { text: "Catalog" }, ...doc({ note: "read-mostly; cache-backed" }) },
      { type: "rectangle", id: "n_orders", x: 1340, y: 160, width: 200, height: 90, strokeColor: "#e03131", label: { text: "Orders" }, ...doc({ detail: { frameId: "f_orders_d" }, note: "the money path — everything else degrades first" }) },
      { type: "rectangle", id: "n_pay", x: 1760, y: 160, width: 200, height: 90, label: { text: "Payments" }, ...doc({ detail: { frameId: "f_pay_d" }, tags: ["pci"], note: "PCI scope — isolated VPC" }) },
      { type: "arrow", id: "e_gw_auth", x: 700, y: 170, width: 290, height: -60, label: { text: "verify JWT", fontSize: 14 }, start: { id: "n_gw" }, end: { id: "n_auth" } },
      { type: "arrow", id: "e_gw_catalog", x: 700, y: 220, width: 290, height: 100, label: { text: "browse", fontSize: 14 }, start: { id: "n_gw" }, end: { id: "n_catalog" } },
      { type: "arrow", id: "e_gw_orders", x: 700, y: 195, width: 630, height: 10, strokeColor: "#e03131", label: { text: "place order" }, start: { id: "n_gw" }, end: { id: "n_orders" } },
      { type: "arrow", id: "e_orders_pay", x: 1550, y: 205, width: 200, height: 0, strokeColor: "#e03131", label: { text: "charge", fontSize: 14 }, start: { id: "n_orders" }, end: { id: "n_pay" } },
      { type: "frame", id: "f_core", name: "02 Core Services", children: ["n_auth", "n_catalog", "n_orders", "n_pay", "e_orders_pay"], ...doc({ narrative: "Four services own the business: Auth verifies, Catalog serves the shop window, Orders runs the money path, and Payments talks to the outside world from its own isolated scope." }) },

      // ------------------------------------------------ 03 Data Plane
      { type: "ellipse", id: "n_pg", x: 1000, y: 820, width: 180, height: 90, backgroundColor: "#a5d8ff", label: { text: "Postgres" }, ...doc({ note: "single writer; replicas serve reads" }) },
      { type: "ellipse", id: "n_redis", x: 1320, y: 820, width: 170, height: 85, backgroundColor: "#a5d8ff", label: { text: "Redis" }, ...doc({ note: "read-through cache; 5-min TTL" }) },
      { type: "rectangle", id: "n_kafka", x: 1650, y: 810, width: 210, height: 95, backgroundColor: "#d0bfff", label: { text: "Event Bus" }, ...doc({ note: "source of truth for events; 7-day retention" }) },
      { type: "ellipse", id: "n_s3", x: 2010, y: 820, width: 170, height: 85, backgroundColor: "#a5d8ff", label: { text: "Object Store" } },
      { type: "arrow", id: "e_orders_pg", x: 1420, y: 250, width: -300, height: 570, strokeColor: "#e03131", label: { text: "orders schema", fontSize: 14 }, start: { id: "n_orders" }, end: { id: "n_pg" } },
      { type: "arrow", id: "e_catalog_redis", x: 1150, y: 370, width: 240, height: 450, label: { text: "hot reads", fontSize: 14 }, start: { id: "n_catalog" }, end: { id: "n_redis" } },
      { type: "arrow", id: "e_pay_pg", x: 1800, y: 250, width: -650, height: 580, label: { text: "ledger", fontSize: 14 }, start: { id: "n_pay" }, end: { id: "n_pg" } },
      { type: "arrow", id: "e_orders_kafka", x: 1500, y: 250, width: 250, height: 560, strokeStyle: "dashed", strokeColor: "#e03131", label: { text: "OrderPlaced" }, start: { id: "n_orders" }, end: { id: "n_kafka" } },
      { type: "frame", id: "f_data", name: "03 Data Plane", children: ["n_pg", "n_redis", "n_kafka", "n_s3"], ...doc({ narrative: "Postgres holds the truth, Redis absorbs the reads, and the Event Bus is how anything important leaves a service — nothing talks to a worker directly." }) },

      // ------------------------------------------------ 04 Async Workers
      { type: "rectangle", id: "n_email", x: 40, y: 800, width: 190, height: 70, backgroundColor: "#b2f2bb", label: { text: "Email Worker" } },
      { type: "rectangle", id: "n_fulfill", x: 320, y: 800, width: 220, height: 70, backgroundColor: "#b2f2bb", label: { text: "Fulfillment Worker" }, ...doc({ note: "talks to 3PL APIs; retries with backoff" }) },
      { type: "rectangle", id: "n_invoice", x: 40, y: 960, width: 190, height: 70, backgroundColor: "#b2f2bb", label: { text: "Invoice Worker" } },
      { type: "arrow", id: "e_kafka_email", x: 1640, y: 850, width: 1410, height: 15, points: [[0, 0], [-500, 90], [-1000, -50], [-1410, -15]], roundness: { type: 2 }, strokeStyle: "dashed", label: { text: "OrderPlaced", fontSize: 14 }, start: { id: "n_kafka" }, end: { id: "n_email" } },
      { type: "arrow", id: "e_kafka_fulfill", x: 1640, y: 880, width: 1100, height: -30, points: [[0, 0], [-400, 60], [-800, 20], [-1100, -30]], roundness: { type: 2 }, strokeStyle: "dashed", label: { text: "OrderPlaced", fontSize: 14 }, start: { id: "n_kafka" }, end: { id: "n_fulfill" } },
      // Deliberately unbound: resolved by proximity, exported as inferred.
      { type: "arrow", id: "e_invoice_s3", x: 240, y: 1000, width: 1760, height: -130, points: [[0, 0], [1760, -130]], strokeStyle: "dashed", label: { text: "archive PDFs", fontSize: 14 } },
      { type: "frame", id: "f_workers", name: "04 Async Workers", children: ["n_email", "n_fulfill", "n_invoice"], ...doc({ narrative: "Everything that can happen later happens here: email, fulfillment, and invoicing all hang off the event bus and never block an order." }) },

      // ------------------------------------------------ Tier 2: Gateway internals
      { type: "rectangle", id: "g_tls", x: 60, y: 21260, width: 190, height: 70, label: { text: "TLS / WAF" } },
      { type: "rectangle", id: "g_rate", x: 360, y: 21260, width: 180, height: 70, label: { text: "Rate Limiter" }, ...doc({ note: "token bucket per API key" }) },
      { type: "rectangle", id: "g_router", x: 650, y: 21260, width: 160, height: 70, backgroundColor: "#e9ecef", label: { text: "Router" }, ...doc({ detail: { frameId: "f_route_d" } }) },
      { type: "arrow", id: "ge_1", x: 260, y: 21295, width: 90, height: 0, start: { id: "g_tls" }, end: { id: "g_rate" } },
      { type: "arrow", id: "ge_2", x: 550, y: 21295, width: 90, height: 0, start: { id: "g_rate" }, end: { id: "g_router" } },
      { type: "frame", id: "f_gw_d", name: "API Gateway — internals", children: ["g_tls", "g_rate", "g_router", "ge_1", "ge_2"], ...doc({ narrative: "Inside the gateway: terminate and scrub first, throttle second, route last." }) },

      // ------------------------------------------------ Tier 2: Orders internals
      { type: "rectangle", id: "o_rest", x: 1160, y: 21260, width: 170, height: 70, label: { text: "REST API" } },
      { type: "rectangle", id: "o_osm", x: 1440, y: 21260, width: 210, height: 70, backgroundColor: "#e9ecef", strokeColor: "#e03131", label: { text: "Order State Machine" }, ...doc({ detail: { frameId: "f_osm_d" } }) },
      { type: "rectangle", id: "o_outbox", x: 1760, y: 21260, width: 190, height: 70, label: { text: "Outbox Publisher" }, ...doc({ note: "transactional outbox — atomic with the order write" }) },
      { type: "arrow", id: "oe_1", x: 1340, y: 21295, width: 90, height: 0, start: { id: "o_rest" }, end: { id: "o_osm" } },
      { type: "arrow", id: "oe_2", x: 1660, y: 21295, width: 90, height: 0, strokeStyle: "dashed", start: { id: "o_osm" }, end: { id: "o_outbox" } },
      { type: "frame", id: "f_orders_d", name: "Orders — internals", children: ["o_rest", "o_osm", "o_outbox", "oe_1", "oe_2"], ...doc({ narrative: "A thin REST layer drives the state machine; every transition that matters is published through the transactional outbox, never fire-and-forget." }) },

      // ------------------------------------------------ Tier 2: Payments internals
      { type: "rectangle", id: "p_idem", x: 2360, y: 21260, width: 210, height: 70, label: { text: "Idempotency Guard" }, ...doc({ note: "dedupe by client key; 24h window" }) },
      { type: "rectangle", id: "p_psp", x: 2680, y: 21260, width: 170, height: 70, label: { text: "PSP Adapter" } },
      { type: "rectangle", id: "p_ledger", x: 2680, y: 21460, width: 170, height: 70, backgroundColor: "#a5d8ff", label: { text: "Ledger Writer" } },
      { type: "arrow", id: "pe_1", x: 2570, y: 21295, width: 110, height: 0, start: { id: "p_idem" }, end: { id: "p_psp" } },
      // Elbow route: right, down, into the ledger.
      { type: "arrow", id: "pe_2", x: 2860, y: 21295, width: 60, height: 200, points: [[0, 0], [60, 0], [60, 200], [0, 200]], start: { id: "p_psp" }, end: { id: "p_ledger" } },
      { type: "frame", id: "f_pay_d", name: "Payments — internals", children: ["p_idem", "p_psp", "p_ledger", "pe_1", "pe_2"], ...doc({ narrative: "Charges are deduped before they ever reach the provider; every provider response lands in the ledger before we acknowledge." }) },

      // ------------------------------------------------ Tier 3: Router logic
      { type: "rectangle", id: "r_table", x: 60, y: 41260, width: 180, height: 70, label: { text: "Route Table" } },
      { type: "rectangle", id: "r_pick", x: 360, y: 41260, width: 210, height: 70, label: { text: "Least-Conn Picker" } },
      { type: "arrow", id: "re_1", x: 250, y: 41295, width: 100, height: 0, label: { text: "match path", fontSize: 14 }, start: { id: "r_table" }, end: { id: "r_pick" } },
      { type: "frame", id: "f_route_d", name: "Router — logic", children: ["r_table", "r_pick", "re_1"], ...doc({ narrative: "Match the path against the table, then pick the least-loaded backend." }) },

      // ------------------------------------------------ Tier 3: Order lifecycle
      { type: "rectangle", id: "s_created", x: 1160, y: 41260, width: 150, height: 60, label: { text: "Created" } },
      { type: "rectangle", id: "s_reserved", x: 1420, y: 41260, width: 150, height: 60, label: { text: "Reserved" } },
      { type: "rectangle", id: "s_charged", x: 1680, y: 41260, width: 150, height: 60, label: { text: "Charged" } },
      { type: "rectangle", id: "s_fulfilled", x: 1940, y: 41260, width: 160, height: 60, label: { text: "Fulfilled" } },
      { type: "rectangle", id: "s_cancelled", x: 1420, y: 41440, width: 150, height: 60, strokeStyle: "dashed", label: { text: "Cancelled" } },
      { type: "arrow", id: "se_1", x: 1310, y: 41290, width: 110, height: 0, label: { text: "reserve stock", fontSize: 14 }, start: { id: "s_created" }, end: { id: "s_reserved" } },
      { type: "arrow", id: "se_2", x: 1570, y: 41290, width: 110, height: 0, label: { text: "charge card", fontSize: 14 }, start: { id: "s_reserved" }, end: { id: "s_charged" } },
      { type: "arrow", id: "se_3", x: 1830, y: 41290, width: 110, height: 0, label: { text: "ship", fontSize: 14 }, start: { id: "s_charged" }, end: { id: "s_fulfilled" } },
      { type: "arrow", id: "se_4", x: 1495, y: 41320, width: 0, height: 120, strokeStyle: "dashed", label: { text: "timeout 15m", fontSize: 14 }, start: { id: "s_reserved" }, end: { id: "s_cancelled" } },
      { type: "frame", id: "f_osm_d", name: "Order lifecycle", children: ["s_created", "s_reserved", "s_charged", "s_fulfilled", "s_cancelled", "se_1", "se_2", "se_3", "se_4"], ...doc({ narrative: "Every order walks this ladder left to right; the only way out is a reservation timeout, and cancellation is impossible once the card is charged." }) },
    ],
    { regenerateIds: false },
  );

  // The converter re-bounds frames around any overlapping arrow and assigns
  // memberships by geometry — cross-frame arrows inflate every frame. Enforce
  // the intended geometry and memberships explicitly.
  const FRAME_GEOM: Record<string, [number, number, number, number]> = {
    f_edge: [20, 40, 700, 300],
    f_core: [960, 20, 1040, 400],
    f_data: [960, 770, 1260, 190],
    f_workers: [20, 760, 560, 310],
    f_gw_d: [20, 21200, 830, 190],
    f_orders_d: [1120, 21200, 870, 190],
    f_pay_d: [2320, 21200, 570, 390],
    f_route_d: [20, 41200, 590, 190],
    f_osm_d: [1120, 41200, 1020, 360],
  };
  const MEMBER: Record<string, string> = {
    n_user: "f_edge", n_cdn: "f_edge", n_gw: "f_edge", e_user_gw: "f_edge", e_user_cdn: "f_edge",
    n_auth: "f_core", n_catalog: "f_core", n_orders: "f_core", n_pay: "f_core", e_orders_pay: "f_core",
    n_pg: "f_data", n_redis: "f_data", n_kafka: "f_data", n_s3: "f_data",
    n_email: "f_workers", n_fulfill: "f_workers", n_invoice: "f_workers",
    g_tls: "f_gw_d", g_rate: "f_gw_d", g_router: "f_gw_d", ge_1: "f_gw_d", ge_2: "f_gw_d",
    o_rest: "f_orders_d", o_osm: "f_orders_d", o_outbox: "f_orders_d", oe_1: "f_orders_d", oe_2: "f_orders_d",
    p_idem: "f_pay_d", p_psp: "f_pay_d", p_ledger: "f_pay_d", pe_1: "f_pay_d", pe_2: "f_pay_d",
    r_table: "f_route_d", r_pick: "f_route_d", re_1: "f_route_d",
    s_created: "f_osm_d", s_reserved: "f_osm_d", s_charged: "f_osm_d", s_fulfilled: "f_osm_d", s_cancelled: "f_osm_d",
    se_1: "f_osm_d", se_2: "f_osm_d", se_3: "f_osm_d", se_4: "f_osm_d",
  };
  for (const el of elements) {
    const geom = FRAME_GEOM[el.id];
    if (geom) {
      Object.assign(el, { x: geom[0], y: geom[1], width: geom[2], height: geom[3] });
      continue;
    }
    const mutable = el as { frameId?: string | null; containerId?: string | null };
    const owner = mutable.containerId ?? el.id;
    mutable.frameId = MEMBER[owner] ?? null;
  }
  return serializeAsJSON(
    elements,
    restoreAppState({ viewBackgroundColor: "#ffffff" }, null),
    {},
    "local",
  );
}
