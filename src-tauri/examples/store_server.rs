//! The desktop store, on loopback, with nothing around it — no window, no
//! menu, no webview.
//!
//! It exists for the cross-implementation parity harness: the store contract
//! (D17/D18, extended by S14) has two implementations, and the only way to be
//! sure they answer identically is to send one scripted sequence to both and
//! diff the answers. `server/docent-store.mjs` is already runnable that way;
//! this makes the Rust half runnable the same way.
//!
//!   cargo run --example store_server
//!   DOCENT_DATA=/tmp/data DOCENT_SECRETS=/tmp/secrets.json cargo run --example store_server
//!
//! The first line of stdout is the base URL, so a harness can read the
//! ephemeral port rather than guess one. Dialogs are stubbed to "cancelled":
//! this binary is never in front of a user.

use std::path::PathBuf;
use std::sync::Arc;

use docent_lib::store::{self, StubDialog};

fn main() {
    let data_dir = PathBuf::from(
        std::env::var("DOCENT_DATA").unwrap_or_else(|_| "target/parity-data".to_string()),
    );
    let secrets_file = PathBuf::from(
        std::env::var("DOCENT_SECRETS")
            .unwrap_or_else(|_| "target/parity-secrets.json".to_string()),
    );
    let store = store::spawn(data_dir, secrets_file, Arc::new(StubDialog::new("cancel")))
        .expect("store binds loopback");
    println!("{}", store.base_url());
    // Nothing else to do on this thread; the store owns one of its own and the
    // harness ends the process when it is finished with it.
    loop {
        std::thread::park();
    }
}
