# Docent

> A docent walks you through the museum. This one walks humans — and AI agents — through your architecture.

Docent wraps [Excalidraw](https://github.com/excalidraw/excalidraw) and adds the three things it's missing:

**🎥 Continuous-camera presentations.** Frames become waypoints. The camera glides,
zooms, and dives between them — Prezi-style, no slide cuts. Your architecture as
one unbroken take.

**📦 Semantic export.** Resolves arrow bindings into an explicit node/edge graph,
strips rendering noise (~70% of the raw tokens), and emits Mermaid plus a compact
JSON sidecar for spatial context. Diagrams a model can actually read.

**🤖 Agent-drivable canvas.** The same semantic layer runs in reverse — agents can
create and mutate diagrams programmatically, not just consume them.

No fork. Excalidraw stays upstream; Docent is a wrapper. Self-host with Docker in
one command.
