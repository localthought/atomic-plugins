# Willow Atomic export adapter

Status: **experimental partial implementation** in QuickJS JavaScript.
This package implements real Willow Entry encodings and creates reviewed
unsigned export candidates from Atomic resources. It does **not** implement
WGPS, Willow Confidential Sync, a peer listener, Meadowcap signing or live sync.
The existing [Willow drop importer](../willow-drop/README.md) remains unchanged
and handles the separate signed file-import workflow.

## Implemented protocol slice

`codec.mjs` implements canonical `encode_entry` and `encode_path`, their general
encoding-relation decoders, compact U64 integers, and relative Entry
encoding/decoding. These are the actual byte layouts defined by the
[Willow encoding specification](https://willowprotocol.org/specs/encodings/index.html),
using the [Willow’25 parameter choices](https://willowprotocol.org/specs/willow25/).
Paths retain binary components, including empty and non-UTF8 components, with
the 4096 limits. Timestamps and payload lengths stay unsigned 64-bit BigInts.
The decoder rejects truncation, trailing data, impossible paths and timestamp
overflow/underflow. Canonical decoding additionally rejects nonminimal tags.

Absolute Entry/path decoding passes all **827 upstream vectors**, including
rejected encodings, and matches upstream canonical reencodings. The provenance
and exact revision are in [fixtures/README.md](fixtures/README.md). Relative
Entry tests use a hand-calculated normative example and boundary/roundtrip
checks; no independent live peer has exercised them.

An Entry contains metadata and a payload digest; decoding it does not verify
an authorisation token or establish that the bytes represent an authorised
write. These APIs intentionally make no such claim.

## Actual Atomic adapter

`exportCandidate(ctx, config, subject)` reads the selected resource through the
host's existing scoped `ctx.read`, copies only explicitly selected property
values, and serializes a deterministic JSON-AD payload with its source `@id`.
It computes the real WILLIAM3 payload digest and canonical Willow Entry signing
bytes. The path is the configured binary prefix followed by one UTF-8 component
containing the full Atomic subject; it is never inferred from a display name.

`run(ctx)` uses that adapter and the existing `ctx.query`/`ctx.read` APIs to
return real Atomic `create`/`set` intents. After the host previews, approves and
applies those intents, ordinary resources under `outputParent` hold the unsigned
candidate in `description` and `importBaseline`, with a stable `localId`. The
baseline includes source `values` for name/description and the exact `previous`
source map required by the host import compare-and-set validator. Local edits
to either field require reconciliation; an older envelope without a baseline
map is refused. No
candidate is sent to a peer. Returning an intent is not evidence it was durably
stored.

The candidate envelope is an **application-specific JSON container**, named
`atomic-willow-signing-candidate-v1`, not a Willow interchange format. It carries:

- `entryHex`: exact canonical `encode_entry` bytes, ready for a future authorised
  signer to inspect and sign;
- `payloadHex`: the exact raw payload bytes;
- `source`, `mediaType` and an explicit `status: unsigned`.

`checkCandidate` verifies byte shape, canonical encoding, payload length and
WILLIAM3 digest. It performs no signature or Meadowcap validation. The selected
JSON-AD serialization is an application payload choice; Willow permits arbitrary
payloads. No native/Rust library, key material, network or invented host API is
used in this adapter.

The build reuses `../willow-drop/william3.ts`, without changing it or copying
its source into a second implementation. It strips TypeScript and combines the
primitive, codec and adapter into a standalone `plugin.js`. An explicitly
allowlisted CI dependency causes Willow tests to run when that one shared
primitive changes; arbitrary sibling-folder dependencies remain rejected.

## Configuration and use

Install the generated `plugin.js` as a sandbox job and supply configuration:

```json
{
  "subjects": ["https://atomic.example/notes/hello"],
  "properties": [
    "https://atomicdata.dev/properties/name",
    "https://atomicdata.dev/properties/description"
  ],
  "outputParent": "https://atomic.example/willow-candidates",
  "namespace": "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318",
  "subspace": "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318",
  "pathPrefix": ["61746f6d6963"],
  "timestamp": "1"
}
```

The namespace/subspace above are the published Willow’25 example identifiers,
not a provisioned private namespace or proof of write permission. Replace them
with the intended public identifiers. `pathPrefix` is an array of hexadecimal
binary components (`61746f6d6963` is `atomic`). `timestamp` is explicitly supplied
as a logical clock value, not a fabricated conversion from Unix milliseconds.
Increase it whenever replacing an existing candidate. Unchanged exports reuse
the stored identity; lower/equal timestamps with changed bytes are refused.
Local edits to a stored candidate also require manual reconciliation.

Run the job, review the proposed resources and apply through the host. Choose
an output parent with the intended access policy: staging copies of selected
source properties into another parent can change who can read those copies,
so the ordinary host preview/write review remains essential. The host enforces
the installing actor and installation permissions on all reads and writes.
Config does not grant permission. Unselected properties are never serialized,
and an out-of-list subject is rejected before reading it.

Limits are 32 selected resources, 32 selected properties and 64 KiB payloads.
An invalid or denied record fails the whole proposal without partial intents.
This is a bounded reviewed export, not continuous sync, a source snapshot
transaction, or an atomic batch apply. Loro editor state, blob bytes and linked
resources are not recursively exported: only the selected JSON-AD atoms are.

## Required host bridge for live sync

A host-owned signer must validate Meadowcap authority against the actual
namespace, subspace, path and timestamp, then sign these exact bytes and produce
an AuthorisedEntry. It must bind the selected source revision and output target
to the actor/installation approval, enforce quotas and revocation, and reject
stale approvals. A configured public key or an unsigned candidate is insufficient.

The live engine still requires durable peer/session state, authorised blob
storage, stream transport, confidentiality, cancellation and reconnect handling.
QuickJS cannot open sockets or maintain a session across fresh invocations.
The accepted design places the full engine in a host extension or sidecar;
[atomic-server#1722](https://github.com/ontola/atomic-server/issues/1722) and
[#1723](https://github.com/ontola/atomic-server/issues/1723) track those host
boundaries. This package installs no route and opens no listener.

## Validation

Requires Node 22.13+ for the build-time TypeScript stripping API:

```sh
node integrations/willow/build.mjs
node integrations/tooling/run-lane.mjs willow --tier node
node --experimental-strip-types integrations/willow/verify-host.mjs /path/to/pinned/atomic-server
```

The node lane runs codec and adapter tests, including the 827 independent encoding vectors,
export field confinement, unsigned intent generation, monotonic timestamps,
local-edit/denial handling, payload integrity and bundle reproducibility.
Fixtures simulate applying intent-shaped objects; this is unit evidence, not
real Atomic persistence or QuickJS runtime evidence.

The explicit host contract check invokes the pinned host's actual
`validateManifest` and `parseVerdict` source functions. It passed at
`35504494261f59e922e79d536fd437954451e6a3`. A real host apply/reload roundtrip,
Meadowcap signer and independent peer transfer remain unverified.
