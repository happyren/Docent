// Release builds must not open a console window alongside the canvas.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    docent_lib::run()
}
