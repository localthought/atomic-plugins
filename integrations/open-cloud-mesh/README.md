# Open Cloud Mesh

Status: **experimental implementation slice**, not a working federated receiver.
This package now contains executable QuickJS JavaScript, a v3 host manifest,
a reproducible bundle, and protocol/Atomic mapping tests. `manifest.json` and
`plugin.js` are the host release inputs.

## Implemented behavior

`handle(ctx, request)` serves disabled OCM 1.3 discovery at `/ocm-provider`
with `enabled: false` and no resource types. `HEAD` has no body. The
`drive-host` manifest targets the drive's configured hostname. POST
`/ocm/shares` returns 501 and never emits intents, even when a caller or share
body claims to be authorized. This release does not claim a well-known path.

`parseShare` validates a bounded subset of the official OCM 1.3 `NewShare`
contract: user/file shares with WebDAV metadata (`multi` or legacy `webdav`),
required identity fields, permission names and safe-integer expiration. Input
is limited to 16,384 JavaScript characters. Unsupported requirements, folders,
groups and protocols are refused. Relative WebDAV references are accepted;
absolute references must use HTTPS without embedded credentials. WebDAV
locations and shared secrets are excluded from its returned metadata.

`run(ctx)` implements an **operator-reviewed metadata import** using actual
host `ctx.read`, `ctx.query` and create intents. It validates an allowed peer,
recipient and existing accessible Atomic `Document` or `DocumentV2`, then
proposes a `Message` beneath that document with `about` pointing to the
same document. This is a native comment visible in the data browser's comments
panel, with a readable escaped Markdown receipt. It does not change the
original document content, permissions or Loro/Yjs state. The ordinary host
job planning/review/apply path authorizes storage writes.

The mapping was checked against pinned Atomic Server `35504494261f59e922e79d536fd437954451e6a3`:
`lib/defaults/chatroom.json` defines Message's required description/parent and
`about` as an Atomic resource reference; `CommentsPanelContainer.tsx` queries
that property. `browser/lib/src/ontologies/dataBrowser.ts` defines the two
supported document classes. `server/src/plugins/plan.rs` parses these create
intents. No new host methods or arbitrary document-content encodings are used.

An identity tuple of peer origin, provider share ID and recipient is persisted
using Atomic's `localId` property. A subsequent fresh job finds an identical
receipt and emits no changes. Multiple matching receipts, a different document,
changed metadata or inaccessible resources fail closed. This is replay handling
for sequential reviewed jobs, **not an atomic uniqueness guarantee** for
concurrent imports. The host must serialize/review such imports.

## Manual import configuration

Provide installation-owned configuration, then execute the normal reviewed job
path with the release's `run` entrypoint. The operator must inspect the source
and remove credentials before putting share JSON into configuration:

```json
{
  "publicOrigin": "https://atomic.example",
  "mode": "import-reviewed-share",
  "peerOrigin": "https://cloud.example",
  "allowedPeers": { "https://cloud.example": true },
  "recipient": "bob@atomic.example",
  "document": "https://atomic.example/documents/project",
  "shareJson": "{\"name\":\"Design.md\",\"providerId\":\"share-123\",\"owner\":\"alice@cloud.example\",\"sender\":\"alice@cloud.example\",\"shareWith\":\"bob@atomic.example\",\"shareType\":\"user\",\"resourceType\":\"file\",\"protocol\":{\"name\":\"multi\",\"webdav\":{\"uri\":\"share-123\",\"permissions\":[\"read\"]}}}"
}
```

Peer origin is an operator assertion for this manual workflow, not proof of a
network identity. Never connect untrusted incoming HTTP JSON to this job.
No access token, shared secret or remote content URI enters the receipt intents.
The resulting Message explicitly says content has not been imported.

## Host requirements and remaining receiver work

The pinned host now implements route dispatch, the build/runtime/install gates,
QuickJS `handle`, and well-known routing. But `route_exec.rs` still rejects
non-anonymous authentication before running a plugin, and rejects all route
intents/enqueues even at `read-write`. Host route writes (#1717), signatures and
tokens (#1718), and durable deliveries (#1719) are required before accepting
network shares or issuing accept/reject notifications. There is no supported
QuickJS API for importing remote blob bytes or editing a document's Loro state.

Every public route requires Cargo feature `plugin-routes`, operator switch
`--plugin-routes read-write` (required by the host for the POST route, even though it returns an error without writing), and
Installation consent. atomic.place builds omit the feature. No unauthenticated
write fallback exists. The manifest's anonymous POST route only explains the
unavailable service; installing it does not enable OCM receiving.

Still required for [receiver issue #138](https://github.com/ontola/atomic-plugins/issues/138):
authenticated peer binding, network acceptance and durable share state, expiry
and revocation enforcement for remote access, notifications/retries, content
fetch/import, and an independent OCM peer interoperability run. No peer or
QuickJS/live host execution has been verified by these Node tests. Sending
shares and WebDAV content serving remain subsequent work.

## Build and CI

```sh
node integrations/open-cloud-mesh/build.mjs
node integrations/tooling/run-lane.mjs open-cloud-mesh --tier node
```

The executable Node lane tests discovery and unavailable receiving, protocol
validation/limits, actual intent shape, document binding, replay/conflicts,
permission/read failures, credential exclusion and deterministic bundling.
It needs no browser dependencies. `plugin.js` is generated; edit `plugin.mjs`.

## Specification and OpenGeoMesh reference

Wire fields were checked against the official
[OCM 1.3.0 specification](https://github.com/cs3org/OCM-API/blob/v1.3.0/spec.yaml),
including `Discovery` and `NewShare`. Fixtures are synthetic and there is no
claim of full 1.3 conformance or compatibility with newer versions.

[OpenGeoMesh's opencloudmesh crate](https://docs.rs/opencloudmesh/latest/opencloudmesh/)
provides a useful protocol reference, but cannot be linked into QuickJS. This
implementation uses JavaScript and the OCM specification directly; no Rust
source or dependency is bundled. The [accepted route design](../../docs/design/server-plugin-routes.md)
provides the intended C receiver/B delivery placement.

## Reviewed notification lifecycle

The OCM 1.3 `NewNotification` schema requires `notificationType`, `resourceType`
and `providerId`; it permits an optional protocol-specific `notification`
object. This implementation supports the named file notifications
`SHARE_ACCEPTED`, `SHARE_DECLINED` and `SHARE_UNSHARED`. Other notification types
and resource types are refused. Optional notification parameters are validated
as an object but never persisted: the specification explicitly permits a
`sharedSecret` there. This is a metadata workflow, not token processing.

For a previously imported receipt, run the normal reviewed job with the same
peer policy, recipient and document configuration, changing these fields:

```json
{
  "mode": "apply-reviewed-notification",
  "expectedState": "recorded",
  "notificationJson": "{\"notificationType\":\"SHARE_ACCEPTED\",\"resourceType\":\"file\",\"providerId\":\"share-123\"}"
}
```

The notification does not carry a recipient in this spec. The operator must
identify and review both its peer provenance and recipient; neither is inferred
or authenticated from the notification JSON. The job looks up the exact persisted
peer/provider-ID/recipient tuple, requires one matching Message, checks its
parent and `about` link against the configured existing document, and checks
that the receipt text has not been locally edited.

New receipts persist lifecycle metadata in the host's existing JSON
`importBaseline` property. States are `recorded`, `accepted`, `declined` and
`unshared`. The local policy permits recorded → accepted/declined/unshared and
accepted → unshared. Declined/unshared are terminal; this conservative policy
is ours, not a state machine defined by OCM. A repeat of the recorded last
notification is a no-op; conflicting or stale transitions fail without intents.
A later share reimport preserves the existing lifecycle instead of resetting it.
Exact pre-lifecycle receipts can gain their baseline through another reviewed
share import; edited or ambiguously bound legacy receipts cannot.

A transition proposes only two property changes on the existing receipt:
`importBaseline` and its readable description. It does not change the
underlying document, permissions, content, credentials or remote share. In
particular an `unshared` receipt is **not enforcement of remote or Atomic access
revocation**. No notification is sent or acknowledged over the network. POST
`/ocm/notifications` is explicitly 501 behind the same host gates as shares.

`expectedState` is checked while planning, not an atomic compare-and-swap at
commit. Serialize reviewed jobs and resolve concurrent plans before application;
there is no transaction/snapshot guarantee. OCM1.3 has no notification event ID
in this schema, so idempotency here recognizes repeated resulting decisions,
not an authenticated durable inbox log. Live host and peer interoperability
remain unverified.

Peer origins are canonicalized before policy checks and identity lookup: HTTPS
scheme/DNS case are normalized, port 443 is omitted, and other numeric ports
must be 1–65535. Policy keys undergo the same normalization; contradictory
allow/deny aliases fail closed. Malformed DNS labels, IP spellings, trailing
dots, credentials, paths and query strings are not accepted by this deliberately
restricted parser. An old receipt keyed with explicit `:443` is refused for
manual reconciliation rather than silently migrated or duplicated; these
unpublished changes provide no deployed-data migration guarantee.

Document references support canonical `atomic:<genesis>` resource subjects,
legacy `did:ad:` subjects and HTTP(S) resource URLs. The configured subject is
passed unchanged to actual host reads and remains subject to resource type and
permission checks; recognizing its scheme grants no access.
