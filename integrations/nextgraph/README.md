# NextGraph RDF snapshot adapter

Status: **implemented bounded interchange adapter; no live broker verification**.
This is a QuickJS sandbox job using actual Atomic read/query APIs and reviewed
create intents. It is not an `ngd` broker, WebSocket client, CRDT synchronizer,
or encrypted-session implementation.

## Verified interchange boundary

The official [NextGraph App Protocol](https://docs.nextgraph.org/en/specs/protocol-app/)
specifies SPARQL Results JSON for ReadQuery SELECT responses and SPARQL Update
for WriteQuery. Its [framework examples](https://docs.nextgraph.org/en/framework/getting-started/)
show `ng.sparql_query` returning `results.bindings`. This adapter consumes that
standard decoded JSON, not the encrypted broker wire envelope. It emits an
ordinary SPARQL INSERT DATA statement for a separately authorized client to run.
Neither exchange performs broker I/O from QuickJS.

The parser follows [SPARQL 1.1 Results JSON](https://www.w3.org/TR/sparql11-results-json/)
for a deliberately bounded triple projection. It accepts URI, blank-node and
literal terms, preserving exact literal strings, datatype IRIs and language
labels. Subjects cannot be literals, predicates must be IRIs, and every row must
bind exactly `s`, `p`, `o`. Blank-node labels are scoped to one snapshot and
remapped to safe output labels. Numeric lexical values are never converted to
JavaScript numbers. ASK, RDF-star and arbitrary variable projections are rejected.

## Actual Atomic storage

Import mode validates the result and proposes an existing host `create` intent
for a native `https://atomicdata.dev/classes/PlainText` resource. The original
SPARQL JSON bytes are retained in the real `description` property, alongside
name, mimetype and localId. These are actual atoms in Atomic's store **after the
host reviews and applies the intent**. They are not an in-memory plugin store.
The native class requires name and description, as verified in pinned host
`lib/defaults/default_store.json` (PlainText) and browser ontology definitions.
The snapshot uses those ordinary resource fields, not DocumentV2/Loro content.

Export mode reads that actual stored resource using `ctx.read`, preserving host
access checks, revalidates it, and proposes another PlainText resource containing
SPARQL INSERT DATA with MIME type `application/sparql-update`. Permission errors
propagate before any export intent is produced. This provides a reviewable atom
storage round-trip; it does not map RDF predicates to new Atomic ontologies or
mutate the original external subjects.

## Operator workflow

1. In an authorized NextGraph client, select the intended graph/document and run:

   ```sparql
   SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 257
   ```

   Transfer the decoded JSON response. The adapter accepts at most 256 rows;
   the extra row is a sentinel that rejects oversized results instead of silently
   taking a partial snapshot. Input cannot prove which query generated it: do
   not provide results truncated by a smaller limit or an intermediate client.

2. Configure and run the sandbox job with an actual writable Atomic parent:

   ```json
   {
     "mode": "import",
     "parent": "https://your-atomic-server.example/folder",
     "id": "snapshot-1",
     "name": "NextGraph RDF snapshot",
     "result": "<UTF-8 SPARQL Results JSON string>"
   }
   ```

   Review/apply the proposed create intent and retain its assigned Atomic subject.

3. For export, use the following config and review/apply the resulting resource:

   ```json
   {
     "mode": "export",
     "parent": "https://your-atomic-server.example/folder",
     "id": "export-1",
     "name": "NextGraph SPARQL import",
     "sourceSubject": "<actual Atomic snapshot subject>"
   }
   ```

   Use the exported resource's description as the authorized NextGraph client's
   update text against the intended destination graph. It adds triples to that
   client's default graph; it does not erase, synchronize or select another graph.
   Repeated application with blank nodes creates new blank nodes, so this is an
   explicit snapshot transfer, not a retry-safe replication engine.

## Bounds and safety

Input is capped at 65,536 UTF-8 bytes and 256 triples; generated N-Triples/update
text at 131,072 bytes; IDs at 64 ASCII letters/digits/underscore/hyphen; names
at 256 characters. IRIs and language tags are validated before interpolation;
literals are escaped, and raw blank labels never enter generated SPARQL. All
validation completes before a verdict is returned. Duplicate local identities
are refused to avoid accidental overwrites. This query preflight is not an
atomic uniqueness transaction: concurrent reviewed jobs still need host review.

No keys, credentials, binary blobs, broker sessions or peer requests are accepted.
There is no public HTTP route and no authentication shortcut. Automatic transfer
would require host/sidecar scoped operations with broker authorization and durable
acknowledgements, unavailable in the inspected host
`35504494261f59e922e79d536fd437954451e6a3`. The broker remains a native sidecar as
specified by the accepted server plugin design.

## Build and verification

```sh
node integrations/nextgraph/build.mjs
node integrations/tooling/run-lane.mjs nextgraph --tier node
```

The build writes `integrations/nextgraph/dist/plugin.js` and `manifest.json`.
Fourteen Node tests cover standard result parsing, exact RDF term serialization,
reviewed atom import/export, denied reads, malformed/injected input, blank nodes,
UTF-8/row bounds, duplicate snapshots and reproducible executable bundles.
`fixtures/select.json` is a hand-authored standards fixture, not a broker capture.
No live QuickJS execution, actual Atomic commit, independent SPARQL engine or
NextGraph broker transfer has been verified; green CI does not establish those.

The manifest declares every consumed installation configuration field using the
host-supported string/object schema. Conditional fields are checked by the entry
point: result for import, sourceSubject for export; mode/parent/id/name are
always required.
