Vendored from localthought/syncables-rs commit 0ab3521 (codex/browser-integrations), based on d48e4d9bad3ed9ec826d1c2040e989171701965d. This snapshot adds sync_document and target-specific transport/filesystem support. Replace with a pinned upstream dependency after that branch is merged. Apache-2.0; see LICENSE.

Local addition on top of that snapshot: `SyncClient::create`/`update`/`remove`
(`src/sync/client.rs`, `RecordAddress`, `tests/write_back.rs`) — a first
prototype of the write half of upstream issue #9, sending requests
immediately with no local-first write queue or retry/backoff. Port this into
upstream `localthought/syncables-rs` (and drop it here once the pinned
dependency lands) rather than letting it drift as a vendoring-only patch.
