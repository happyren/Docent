// Release builds must not open a console window alongside the canvas.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--agent-stdio` (D38) is the one non-GUI mode: a stdio→loopback MCP
    // pipe for clients that can only spawn a process — no window, no menu,
    // no second instance of the canvas.
    if std::env::args().skip(1).any(|arg| arg == "--agent-stdio") {
        docent_lib::mcp::run_stdio_shim();
        return;
    }
    docent_lib::run()
}
