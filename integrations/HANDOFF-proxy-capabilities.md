# Handoff: signed capabilities for proxy-backed drive plugins

**Resolves:** [ontola/atomic-plugins#21](https://github.com/ontola/atomic-plugins/issues/21),
which blocks Phase 4 of the timesheets/Clockify drive plugin
(`localthought/atomic-plugins#20`).

**Split into:**
- [ontola/atomic-plugins#40](https://github.com/ontola/atomic-plugins/issues/40)
  — the `integration-proxy` half: a persistent DID-bound connection record and
  signature auth.
- [ontola/atomic-server#1624](https://github.com/ontola/atomic-server/issues/1624)
  — the atomic-server half: capability minting in the parent page and one new
  op on the app/iframe protocol.

They can proceed independently up to the point of wiring, and the proxy half is
worth doing on its own merits.

> **This file replaces an earlier design** in which the host persisted the
> rotating connection code on the plugin's behalf (OPFS, a Web Lock, and
> take/store ops per request). That design managed the problem; this one
> removes it. The superseded reasoning is kept in the last section, because the
> measurements it rests on were never taken and someone will otherwise redo it.

## The problem in one paragraph

A drive plugin's iframe is null-origin (`sandbox='allow-scripts allow-modals'`
with no `allow-same-origin`, `AppFrame.tsx:285`), so it has **no storage of any
kind** — no `localStorage`, no IndexedDB, no OPFS, no Web Locks. An Atomic
resource is explicitly off-limits for secrets (`plugin-app.ts`'s `createApp()`:
"A secret in a resource would sync, and the personal drive it lives on can
later be shared"). Phase 2 shipped the credential as a resource property
anyway, which is the bug in #21. So the plugin has nowhere to keep a
credential.

## The answer: don't give it one to keep

The credential's *shape* is the problem, not its storage location. Three facts
decide this:

1. **The rotating code is the only carrier of the grant.** `StoredCredential`
   (`integration-proxy/src/proxy.rs:229-246`) holds the real `access_token` and
   `refresh_token`, sealed into the connection code's envelope and nowhere
   else. There is no persistent per-connection record — `security.rs:100`
   creates only `used_challenges`, `oauth_states`, `connection_codes` and
   `connection_handoffs`.
2. **Ten idle minutes destroys it.** Rows are inserted at `NOW() + INTERVAL '10
   minutes'` (`security.rs:250`) and swept on every write (`security.rs:245`).
   The TTL resets on each rotation, so an active client never expires — but an
   idle one loses the sealed refresh token and needs a full re-OAuth.
3. **It is inherently single-device, single-tab.** It is a single-use bearer
   token in one browser's `localStorage`. A second device means a second OAuth
   flow; two tabs race and the loser's `take_connection_code` returns nothing.

So the current design fails the requirement *even on one device*. Storing it
somewhere better does not fix any of the three.

Instead: the drive holds a **connection reference** (`connectionId` +
`platform`) as ordinary public data — no secret, syncs freely, violates
nothing. Authority comes from a signature, and a short-lived scoped capability
carries it to the frame.

## Sign as the app, not as the person

The signer should be the plugin's **own agent**, not the user's identity. That
agent already exists and is already the thing writes are attributed to:

- `createApp()` returns `{ agent, secret }` — *"The app's own agent. Writes it
  makes are attributable to this DID"* (`browser/lib/src/plugin-app.ts:63-72`).
- Its **public** half is already synced drive data, in a dedicated *App
  identities* folder deliberately kept outside every app's own subtree,
  because *"a key stored in the room it unlocks"* would be replaceable by the
  app. The folder's own description calls it the revocation surface: *"Removing
  one from a resource's rights revokes that app"* (`plugin-app.ts:236-270`).
- Its **secret** is never in the graph. `createApp` returns it once and stores
  it nowhere; callers hand it to the node via `handOverAppKey` → `POST
  /app-agent` (`browser/data-browser/src/chunks/AppPage/appAgent.ts:19-31`),
  which keeps it in `PluginMeta.agent_secret`, its own redb table keyed by
  `(drive, namespace, name)` (`lib/src/db/plugin_meta.rs:12`).

**Minting follows the `/app-write` pattern exactly.** Today the browser signs
as the *user* to `POST /app-write` and the node performs the write as the *app*
(`hostStore.ts:201-226`). A capability endpoint is the same shape: the browser
signs as the user to authorize, the node signs the capability as the app agent.
No new trust path, and the app secret never enters a browser.

What this buys over signing as the person:

- **Per-plugin revocation**, in the place the drive already points at for it.
- **Per-plugin attribution** at the proxy, rather than every plugin's traffic
  arriving as the user.
- **The user's identity never authorizes proxy traffic**, so a compromised
  plugin cannot reach anything the user can reach.
- It matches a scoping decision already made: `planning/plugin-secrets.md` —
  *"Answered: scope is per plugin. Revoking one is then obviously about one
  plugin. The cost is pasting the same token into two importers, which is the
  cheaper mistake."* Here that cost is one OAuth flow per plugin per platform,
  because the proxy's `user_id` becomes the app agent's DID.

## Why this is smaller than it sounds

- **The proxy already records the owning DID** — `StoredCredential` carries
  `user_id`, e.g. `did:ad:agent:test` (`connect.rs:1395`). It knows who owns a
  connection; it just never authenticates with it.
- **The proxy already has challenge/response with replay protection.**
  `verify_connect` checks a timestamped challenge and two signatures
  (`proxy.rs:95-119`), and `used_challenges (nonce PRIMARY KEY, expires_at)`
  with `ON CONFLICT DO NOTHING` (`security.rs:141`) is a replay-nonce table.
  The change is a new verifier — Ed25519 over the caller's DID instead of HMAC
  over a tenant secret — in a shape that exists.
- **Atomic clients already sign without exposing key material.** The user's
  agent key is a non-extractable `CryptoKeyPair`
  (`browser/data-browser/src/helpers/agentStorage.ts:209-223`) and
  `signRequest` exists (`browser/lib/src/authentication.ts:38`) — that is what
  authorizes the mint. The node holds the app agent secret and does the
  signing, so a QuickJS plugin needs no `PluginSecret` for a proxy connection
  at all.

## The one thing this does not solve: a second node

An app agent's two halves sync very differently.

**The public half syncs.** The app's agent *resource* lives in the drive's App
identities folder — ordinary CRDT resource data, replicated like everything
else. A new node learns the app's DID and public key for free.

**The secret half does not, and there is no copy left to send.**

- `PluginMeta` is node-local host state. It is the same redb tree that holds
  the device name, the Iroh secret key and the known-peer list
  (`lib/src/sync/peer.rs:86-123`, `:2270-2315`) — explicitly the "this node,
  not this drive" tree. Nothing replicates it.
- Its contents are wrapped with the node key, which lives in `node.key` beside
  the config at mode 0600 and deliberately **not** in the database it protects
  (`server/src/node_key.rs:1-26`). So even a copied store carries ciphertext.
- The browser hands the secret over exactly once at creation and drops it
  (`plugin-app.ts:66` — "returned once and stored nowhere by this function";
  `appAgent.ts:19-31` → `POST /app-agent`). No party retains a copy to give a
  second node.

So a person's devices share an app agent only as far as they share a *node*.
This is not a regression — today a second device has no connection at all —
but "synced between local-first copies" is only satisfied behind one node, and
that should be said out loud rather than discovered.

**It also looks like a pre-existing gap wider than this feature.** A second
node knows the app exists and cannot act as it, which would affect the app's
ordinary writes and scheduled runs, not just its proxy calls. *Inferred, not
verified* — worth confirming with whoever built the app-agent model before
treating it as a finding.

Three ways out, none of them chosen here:

1. **Hand the key to each node**, extending the existing `POST /app-agent`
   path. Needs a source for the secret, which no browser retains.
2. **Derive the app secret** from the user's agent secret plus the app
   subject, so every node computes the same one and nothing syncs. There is
   precedent — the vault's `blake3::derive_key` hierarchy, and
   `device-pairing.md`'s "the home subject is derived from the Agent key, so
   every device names the same drive". Blocked in a browser, where the agent
   key is non-extractable Ed25519 with no `deriveKey`; fine server-side.
3. **Carry app secrets on the channel that already moves identity between a
   person's own devices** (`planning/device-pairing.md`).

Option 2 is the most consistent with the existing design. It needs its own
decision.

The existing tenant-secret path is not a substitute: a tenant secret is
tenant-wide, so it is not per-user authority and cannot be handed to a browser.
The proxy README is explicit that the browser hub "never needs to paste,
receive, or store a tenant secret."

## The decisive property for the iframe

Single-use rotation is *what forces the parent into every single request* —
that is where the lock, the per-request round trips, and the
dropped-response-kills-the-connection hazard all come from.

A capability is not single-use. The parent mints one at frame start and the
frame then runs an entire sync by itself, with zero postMessage per request.
A newly opened frame asks for a fresh one. Concurrent frames are fine. Idle for
an hour is fine.

## What is being traded, stated plainly

A capability is still a bearer token, and the plugin still sees it. What
changes is that it is short-lived, scoped to one connection and platform, cheap
to re-mint, and **not** the carrier of the underlying grant — losing it costs a
round trip instead of an OAuth flow.

What is not given up: no credential enters a resource, a commit, a sync frame,
a search index, or an LLM's context, which is the whole of #21.

The residual risk is exfiltration by a buggy or prompt-injected plugin during
the capability's lifetime. The mitigation is narrowing the frame's
`connect-src *` (`server/src/handlers/plugin_ui.rs:380`, `:450`) to the proxy
origin — the only egress control browser placement has, where server placement
has `server/src/plugins/egress.rs`.

## What changes in this repo

`integrations/timesheets/` (and the Clockify drive-plugin app, wherever it
lands) stops putting any credential on a resource via `store.save()`, stores
the connection reference instead, and asks the host for a capability.

`integrations/localthought/browser.ts` gains a second auth mode. Its rotating
code path stays for existing callers — the data-browser bundle uses it today
(`PluginRuns/localThought.ts:35`) and nothing forces that to change at once.

## Superseded design, and why

The previous plan kept the rotating code and had the host persist it: an OPFS
store in the parent, a Web Lock per connection, and `take-code`/`store-code`
ops around each request. It was chosen on the grounds that relaying request and
response bodies over `FrameBridge` was too expensive for a paging sync.

Two things undermined it, both discovered after it was written:

- **The saving was smaller than assumed.** Because the lock must span the whole
  take → fetch → store cycle, the parent is synchronously in the loop on every
  request anyway and both postMessage round trips are paid anyway. The only
  real saving over a full relay is not copying bodies across the bridge — not
  round trips, latency, or parallelism. **That measurement was never taken.**
- **It did not meet the requirement.** No amount of host-side durability
  survives the proxy's 10-minute idle sweep, and none of it gives a second
  device a connection.

If the proxy half of this is rejected, the fallback is *not* that design. It is
ciphertext in the drive under a key derived from the **agent secret** — not
from `DriveVaultKey`, since drive sharing is designed to be able to hand over
the drive key, which is the exact case `plugin-app.ts` warns about. Known
blocker: the browser cannot do this, because the agent key is non-extractable
**Ed25519**, which has no `deriveKey`, and vault wrapping happens server-side
in Rust where the secret is plaintext (`planning/encrypted-vault-format.md`).
It would work for a server-backed drive and not for the browser-only
local-first case this is for.

## Not verified

- The Phase 2 code #21 describes (`integrations/clockify/app/src/sync.ts`,
  `App.tsx`, `proxyClient.ts`) was not read: it is not in this repo and not in
  the `00f11ae6d` `atomic-server` checkout used for the refs above.
- Whether body copying across `FrameBridge` is in fact expensive enough to have
  justified the superseded design. Unmeasured, and now moot unless the proxy
  half is rejected.
- OPFS unavailability in the frame was reasoned from the opaque-origin rule and
  the comment at `edit-mode/src/index.ts:17`, not probed from a live frame.
