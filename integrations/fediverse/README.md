# Fediverse

Status: **experimental read implementation**, not a working federated server.
The QuickJS plugin serves one ActivityStreams Service actor, public Atomic
objects, a paginated outbox, WebFinger and NodeInfo. HTTP GETs perform actual
scoped `ctx.read` calls. Inbox receipt, signed delivery and client writes remain
unavailable; the plugin never pretends a POST succeeded.

`plugin.js` and `manifest.json` are the host release inputs. `plugin.json` is
repository metadata. No Rust crate, network client, private key or process-local
persistent state is bundled.

## Native Atomic mapping

The installation explicitly configures a public profile resource and at most
50 publication bindings. The actor takes its name and escaped summary from the
profile's Atomic `name` and `description`. Actor type is `Service` because this
is an operator-curated publication feed, not an assertion that the source
resource is a human Agent.

Each binding has a stable local ID, an existing HTTPS Atomic subject and an
operator-provided publication time. Only selected properties are projected:

| Atomic resource | ActivityStreams object | Data |
| --- | --- | --- |
| Message or PlainText | Note | `description`, HTML-escaped as plain text; optional `name` |
| Document or DocumentV2 | Article | `name` and a link to the actual document; no invented CRDT content |

Each projected object has a stable `/ap/objects/<id>` identity, public addressing,
actor attribution, the configured publication timestamp, and `url` linking to
the source document in the data browser. A matching `/ap/activities/<id>` returns
its Create representation. The outbox is an OrderedCollection whose pages
contain those activities, newest configured time first and ID ascending for ties.

These are live read projections, **not immutable activity records or a delivery
log**. Editing a source changes its projected content; updating ACLs removes
it from subsequent reads. Previously fetched content cannot be recalled. Delete,
Update, tombstone and delivery semantics are not implemented. Pagination is stable
for unchanged config/resources; there is no snapshot across concurrent changes.

## Authorization and bounds

Every manifest route has `principal: anonymous` and `auth: none`. At pinned
Atomic Server `35504494261f59e922e79d536fd437954451e6a3`, `route_exec.rs` translates
that to `ForAgent::Public`; `host_core.rs::get_resource` also checks installation
read grants. Thus a configured subject alone does not grant public access.
There is no fallback to the installation principal, no network permission and
no traversal of referenced properties. A denied/missing object returns 404 and
is omitted from counts and outbox pages. An unreadable profile hides the actor,
all objects and discovery. Host errors are not returned to strangers.

The class/property mapping was inspected against the pinned
`lib/defaults/chatroom.json` Message schema and
`browser/lib/src/ontologies/dataBrowser.ts` document/PlainText definitions.
Message Markdown is exported as escaped literal text, not interpreted as HTML.
Document Loro/Yjs bytes and arbitrary Atomic fields never enter responses.

Limits: 50 configured objects, 10 entries per outbox page, 8,192 characters per
text field, 255 per name and 2,048 per source URL/Accept header. Unsupported
classes and oversized content are omitted. Public HTTPS subjects only; other
subject encodings are not supported in this slice. Config uses exact UTC times
such as `2026-09-24T12:00:00.000Z` and rejects normalized invalid calendar dates.
Duplicate IDs/subjects and malformed configuration yield a generic 503.

## Routes and discovery

- GET/HEAD `/ap/actor`, `/ap/objects/{id}`, `/ap/activities/{id}`.
- GET/HEAD `/ap/outbox`, with `?page=1`, `?page=2`, etc. Root supplies `first`;
  pages provide bounded `orderedItems` and `next`/`prev` as appropriate.
- POST `/ap/inbox` and `/ap/outbox`: 501, with no intents or enqueues.
  GET/HEAD inbox likewise reports unavailable. JSON POST bodies are bounded
  to 16,384 bytes by the host.
- GET/HEAD `/webfinger`, claimed through `/.well-known/webfinger` for `acct:`.
  Exact account matching prevents arbitrary user discovery; repeated `resource`
  parameters are rejected. `rel` filters self links.
- GET/HEAD `/nodeinfo` and `/nodeinfo/2.1`, with an exclusive well-known NodeInfo
  claim. Metadata explicitly reports `federationEnabled: false`; no federation
  protocol is advertised as operational.

ActivityStreams endpoints negotiate `application/activity+json` and
`application/ld+json` (with ActivityStreams profile), including q=0 exclusions.
Unsupported Accept values return 406. HEAD shares GET status and headers with
no body. Responses use `no-store` to avoid caching private-to-public ACL changes.
The host supplies CORS for the declared WebFinger route and generates host-meta
from its registered claim. This plugin does not implement a separate host-meta.

## Configuration and deployment

```json
{
  "origin": "https://social.example",
  "username": "news",
  "profile": "https://atomic.example/public-profile",
  "objects": [
    {
      "id": "announcement-1",
      "subject": "https://atomic.example/public-announcement",
      "published": "2026-09-24T12:00:00.000Z"
    }
  ]
}
```

The profile and bound resources must be local to the host and readable both
publicly and by the Installation. `origin` must be the configured drive-host
origin. Treat origin/username/object IDs as stable protocol identifiers; this
plugin does not implement identity migrations. Publishing a resource through
this feed also attributes it to the configured Service actor, so bindings must
be operator-approved material.

Public surfaces require all three gates: build feature `plugin-routes`, operator
`--plugin-routes read-write`, and Installation consent. **Read-write is required
by this manifest even though it never writes**, because it declares POST routes
that explicitly refuse unsupported requests; the host gate classifies POST as
read-write. atomic.place builds omit the feature. Read-only deployments would
need a separately reviewed GET/HEAD-only manifest; this bundle does not bypass
that gate.

The current host dispatch/read APIs exist, but `route_exec.rs` refuses protected
authentication and route intents/enqueues. Full federation needs host write
support (#1717), host-held keys/signatures (#1718), and durable deliveries (#1719).
No public key is invented, and no private key is configurable. ActivityPub actor
inbox/outbox URLs are present, but a Mastodon or GoToSocial peer cannot yet follow,
post, or receive signed fanout from this actor.

## Validation and remaining work

```sh
node integrations/fediverse/build.mjs
node integrations/tooling/run-lane.mjs fediverse --tier node
```

The dependency-free Node lane executes actor/object mapping, data exclusion,
private read denial, outbox pagination and activity dereferencing, WebFinger,
NodeInfo, negotiation, HEAD, malformed configuration, POST refusal and bundle
reproducibility. It checks the manifest route principals/body modes. These tests
exercise the JavaScript with an in-memory host fixture; they are not QuickJS,
live AtomicServer or independent-peer verification.

[Implementation issue #137](https://github.com/ontola/atomic-plugins/issues/137)
remains open: verified signatures, inbox deduplication, Follow/Accept/Undo,
Update/Delete, durable signed deliveries/retries, restart recovery and an
independent-peer round trip remain required. The accepted C routes/B deliveries
placement is documented in the [server route design](../../docs/design/server-plugin-routes.md).

Wire shapes follow the [W3C ActivityPub Recommendation](https://www.w3.org/TR/activitypub/)
and [ActivityStreams vocabulary](https://www.w3.org/TR/activitystreams-vocabulary/).
Discovery follows [WebFinger RFC 7033](https://www.rfc-editor.org/rfc/rfc7033)
and [NodeInfo 2.1](https://nodeinfo.diaspora.software/protocol.html).
