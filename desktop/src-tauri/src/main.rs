// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Keychain helper mode for the bundled server: answer and exit before
    // anything of the app (single instance, windows, tray) starts.
    let args: Vec<String> = std::env::args().collect();
    if codekin_desktop_lib::secrets::invoked(&args) {
        std::process::exit(codekin_desktop_lib::secrets::run(&args));
    }
    codekin_desktop_lib::run()
}
