# Willow drop importer

Imports the entries of a [Willow](https://willowprotocol.org/) drop file into
a table, after verifying each entry's
[Meadowcap](https://willowprotocol.org/specs/meadowcap/) authorisation and,
where the drop carries it, its payload. It is phase 0 of the
[server plugin routes design](../../docs/design/server-plugin-routes.md)
([#139](https://github.com/ontola/atomic-plugins/issues/139)): placement B, a
sandbox job shaped like [`money/`](../money/). It opens no route and no port,
needs none of the `plugin-routes` gates, and declares no network operations
and no secrets. Willow live sync (WGPS) is a different thing, placement D or
E, and is not attempted here.

Status: **experimental**. What is verified and what is only declared is
listed [below](#verified-and-declared).

## Setup

As for [Bank statements](../money/README.md#setup): publish this folder's
`plugin.js` to a server by hand (there is no catalog-to-store path yet,
[#94](https://github.com/ontola/atomic-plugins/issues/94)), then on the
Integrations page find "Willow drop" among the community plugins, create a
draft, choose **Set up** on its Import tab (this creates the Willow entry
properties, the Willow entry class and a "Willow entries" table), and import a
drop file with **Preview import** and **Apply**. There is no catalog entry
yet; the issue did not ask for one.

A drop can be uploaded as the raw `.drop` file or base64-encoded (`.b64`).

## Evaluation: JS and `wasip2` Willow implementations

The issue asked for this before an importer was written. Checked on
2026-09-24:

| Implementation                                                                                                                | Drop Format                                                                                 | Willow'25 parameters         | Usable in the QuickJS sandbox                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [willow25](https://codeberg.org/worm-blossom/willow_rs) 0.7.9 (Rust, worm-blossom, 2026-08-27)                                | Yes, `drop_format` module (default feature). The site's Rust page still says "coming soon". | Yes; it is the reference     | Not directly. A `wasip2/1` component cannot export `run` on the pinned host yet (design section 1, phase 3). Compiling it for `wasm32-wasip2` was not tried. |
| [willow-js](https://github.com/earthstar-project/willow-js) `@earthstar/willow` 0.6.1 (TypeScript, JSR, last push 2025-03-26) | No: it implements the earlier _sideloading protocol_ (`src/sideload/`), not the Drop Format | No: generic schemes, pre-Bab | No: Deno/JSR package, depends on Deno KV for its store                                                                                                       |
| [meadowcap-js](https://github.com/earthstar-project/meadowcap-js) (last push 2024-07-04)                                      | n/a                                                                                         | Pre-Willow'25 encodings      | Not evaluated further                                                                                                                                        |

Conclusion: there is no JS implementation of the current Drop Format, and the
Rust one cannot run as a sandbox job yet. So this package ports the part it
needs from willow25 0.7.9 to TypeScript (about 650 lines: `encoding.ts`,
`william3.ts`, `drop.ts`), and checks the port against drops that willow25
itself writes (`fixtures/generate/`). The Drop Format page's status is
"Proposal", and willow25's Meadowcap encodings were still being fixed
upstream during this work (commits of 2026-09-18 to 2026-09-23 on the private
area and delegation encodings), which is why delegations are left out below.

## Architecture

- `upload.ts` gets the drop's bytes back. The host only hands files over
  `as: "text"`: the browser decodes the file as UTF-8 if it is valid UTF-8,
  else as windows-1252 (atomic-server `FileImport.tsx`). Both are undone
  exactly (windows-1252 as WHATWG defines it maps each byte to a distinct
  character). `readUpload` tries the UTF-8 reading, the windows-1252 reading
  (only if its bytes are not valid UTF-8, since the host would otherwise not
  have made it) and base64, keeps the readings that decode _and verify_, and
  refuses a file that verifies in two different ways.
- `encoding.ts` holds compact U64s, relative and absolute paths (Willow'25
  limits: 4096 bytes per component, 4096 components, 4096 bytes per path).
  All U64 values are bigints.
- `william3.ts` is WILLIAM3, Bab's BLAKE3-like payload hash: whole-payload
  digests only.
- `drop.ts` decodes each entry relative to the previous one, starting from
  the Willow'25 default entry, and verifies it: a communal capability needs a
  communal namespace (last byte even) and a signature by the subspace key; an
  owned capability needs an owned namespace, an initial authorisation signed
  by the namespace key over `0x03 ‖ user key`, and a signature by the user
  key. Signatures cover `encode_entry` and are checked with `@noble/ed25519`
  (from atomic-server's `browser/lib` dependencies) with RFC 8032 rules
  (`zip215: false`); willow25 uses ed25519-dalek's `verify_strict`, which also
  rejects small-order keys. That difference is not tested.
- `mapping.ts` turns entries into row values and applies Willow's store
  semantics within one drop: an entry is left out when a newer entry of the
  same namespace and subspace has its path or a prefix of it ("newer" as the
  data model defines it: timestamp, then digest, then payload length).
- `plugin.ts` is the manifest and `run()`. Each row's import identity is its
  store key, `["willow25", namespace, subspace, path components]` in hex. An
  entry is also left out when the table already holds a newer entry for the
  same key. Rows are proposed with `importRecords` in `merge` mode, so a
  newer entry updates a row, a local edit is kept when the source did not
  change, and a source change over a local edit is a conflict for review.

Row values are exact strings: namespace, subspace and digest as hex, the path
in willow25's notation (`/a%20b/x%2fy`), the timestamp and payload length as
decimal strings, and the timestamp's UTC reading (see below). Payloads up to
65,536 bytes are stored as text if they are UTF-8, else as base64, with a
status of `stored`, `too-large` or `not-in-drop`; every payload field is
written on every import, so a newer entry never leaves an older payload
behind.

## Verified and declared

Verified by the unit tier (`vitest`, 54 tests, run by the `willow-drop` lane):

- Decoding and verification of four of the five drops willow25 0.7.9 wrote
  (`fixtures/*.drop`, expectations in `fixtures/expected.json`; the fifth,
  `delegated.drop`, must be refused): communal and
  owned namespaces, a switch between them, two subspaces, UTF-8, binary,
  empty and 2,500-byte (three-chunk) payloads, an entry without its payload,
  paths with escaped bytes, prefix pruning, and the empty drop.
- WILLIAM3 against willow25's empty-string digest, its `EntryBuilder`
  documentation example and every fixture payload.
- Refusals: a changed path (signature), a changed payload (digest), a forged
  owned capability, truncation, trailing bytes, a delegated capability, a
  partial payload slice.
- The host's text decoding undone for every fixture, raw and base64, using
  the same `TextDecoder` calls as the host.
- `run()` with a fake host: proposals, repeat import (nothing proposed),
  an entry older than the table's, pruning, configuration errors, and that
  the committed `plugin.js` equals a fresh esbuild bundle.

Verified by the e2e tier (`e2e/willow-drop.spec.ts`, Playwright against the
pinned atomic-server `8270cdf6a`, passed locally on 2026-09-24 in 21 s; the
`willow-drop` lane runs it in CI):

- The committed bundle is published, discovered, set up and run in the
  server's QuickJS sandbox: Ed25519 verification and WILLIAM3 run there.
- A raw binary drop (`communal.drop`) crosses the host's text-only hand-over
  and imports seven rows ("file read as windows-1252"); after a reload the
  rows show the payload text; the same drop again proposes nothing.
- `owned.drop` uploaded base64-encoded proposes four rows.
- `delegated.drop` and a drop with a changed path are refused with their
  messages before anything is proposed.

Declared, not verified:

- Limits: at most 1,000 entries per drop and 5,000,000 bytes per file. The
  sandbox's fuel use per entry (two Ed25519 verifications in plain JS for an
  owned entry, one for a communal entry) has not been measured.
- Interoperability with drops written by anything other than willow25 0.7.9.

## Supported scope and gaps

- Willow'25 parameters only (ed25519 namespace and subspace ids, WILLIAM3,
  Meadowcap). Other parameter sets are not detected; their drops fail to
  verify.
- Capabilities with delegations are refused with a message naming the entry.
  Decoding them needs the private area encodings that upstream fixed as
  recently as 2026-09-23.
- Payload slice modes `10` and `11` (partial payloads, as Bab verifiable
  slice streams) are refused. Mode `00` (no payload) and `01` (whole
  payload) are supported.
- One bad entry refuses the whole drop: the next entries are encoded
  relative to it, so there is no safe way to skip it.
- The drop must end with its `0x00` byte and nothing after it; willow25's
  decoder ignores bytes after the end.
- Prefix pruning applies within a drop and against a row at the same path,
  but an imported entry does not remove existing rows whose path it prunes.
- Timestamps: the data model recommends, but does not require, microseconds
  of TAI since J2000 (2000-01-01 12:00 TT). The `willow-time` column reads
  them that way, converted to UTC with the leap seconds up to 2017-01-01.
  willow25 0.7.9 converts through hifitime, whose `J2000_REF_EPOCH` is
  2000-01-02 12:00 TAI, so its reading of the same timestamp is 86,432.184 s
  later (`mapping.test.ts` pins that difference). The raw value is kept in
  `willow-timestamp`.
- Encrypted drops (the spec recommends encrypting drops for transport) are
  not supported: the spec defines no encryption format.

## Commands

From the repository root, after `node integrations/tooling/link-atomic-server.mjs`:

```sh
node integrations/tooling/run-lane.mjs willow-drop --tier typecheck
node integrations/tooling/run-lane.mjs willow-drop --tier unit
node integrations/tooling/run-lane.mjs willow-drop --tier e2e   # needs the pinned build, AGENTS.md
./browser/node_modules/.bin/esbuild integrations/willow-drop/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 > integrations/willow-drop/plugin.js
```

Regenerating the fixtures needs Rust (edition 2024) and network access for
crates.io. The output is deterministic (fixed ChaCha20 seed); a changed file
means willow25 or the generator changed:

```sh
cd integrations/willow-drop/fixtures/generate && cargo run --release -- ..
```

`certify.mjs` does not cover this package: certification requires named
atomic-server sandbox tests (`atomicCertification.sandboxTests`), and none
exist for it, so it has no `package.json`.
