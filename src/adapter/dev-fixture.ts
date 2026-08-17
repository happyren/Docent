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

export function buildDemoSceneJSON(): string {
  const elements = convertToExcalidrawElements(
    [
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
        type: "frame",
        id: "f_ingress",
        name: "01 Ingress",
        children: ["n_client", "n_gateway"],
      },
      {
        type: "frame",
        id: "f_core",
        name: "02 Core",
        children: ["n_auth", "n_db"],
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
