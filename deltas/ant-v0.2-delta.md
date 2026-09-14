# `.ant` v0.1 → v0.2 delta

For whoever applies this to the spec, the JSON Schema, and the Python /
JS bindings, which live outside this repo. Written to be sufficient on
its own — you should not need to read the Rust.

Reference implementation: the `antares-format` crate (container + reader +
writer) and the reference server's importer/exporter module (`ant_io`) (export + import).

---

## 1. Version compatibility policy

**This is the part to apply first.** v0.1 gated on exact string equality
(`manifest.version == "0.1"`), so a v0.1 reader refused a v0.2 file even
when the only change was additive. Bumping the version without first
fixing the gate breaks every existing reader.

Parse `manifest.version` as `MAJOR.MINOR`. A bare `MAJOR` means
`MAJOR.0`. A value that does not parse is an error.

| file vs reader | behaviour |
|---|---|
| same major, **any** minor | **readable** |
| same major, newer minor | readable; SHOULD expose a "minor ahead" flag |
| same major, older minor | readable, no flag |
| **different major** | **rejected** |

Rules that make the table safe:

1. **Minor bumps are additive-only, by contract.** New record kinds, new
   optional fields. Never a changed field meaning, never a removed or
   repurposed kind.
2. **Unknown record kinds are skipped, not fatal** — within the same
   major — and are **still fed to the running hash**, so trailer
   verification still holds for a reader that skipped records it did not
   understand.
3. **A major bump is reserved for changes an old reader would silently
   misread**: changed semantics, different container framing, a removed
   kind. Rejecting is the only safe response — reading it would produce
   plausible wrong answers.
4. **A newer minor is a known unknown.** It is readable, but the reader
   got a subset. Surface it (Rust: `AntReader::minor_ahead`) so a tool
   reporting completeness to a human can say so.

Rejection messages must say *why*, not "version mismatch". The reference
implementation emits, for a v1.0 file read by a v0.2 reader:

```
file is format v1.0, this reader implements v0.2. Major versions are not
compatible: a major bump means field meanings or the container framing
changed, so reading it here would silently misinterpret records. Upgrade
the reader to a v1.x build, or re-export the file at v0.
```

and for a malformed version:

```
manifest version `banana` is not MAJOR.MINOR; this reader implements 0.2
```

### Binding checklist

- [ ] Replace the equality check with major/minor parsing.
- [ ] Skip unknown `kind` values, still hashing the raw line.
- [ ] Expose the "minor ahead" signal.
- [ ] Make the rejection message name both versions and the reason.

---

## 2. New record kinds: tombstones

**Why.** Import was additive-only. Deleting a vertex at the source and
re-exporting left the record alive at the destination forever, and the
two stores diverged with nothing to detect it.

Two new values of the `kind` discriminator. Both carry the same payload
shape.

```json
{"kind":"vertex_tombstone","data":{
  "id":"deal_1",
  "deletedAt":"2026-08-12T09:15:00Z",
  "author":{"userId":"u_42","subjectType":"user","authoredAt":"2026-08-12T09:15:00Z"}
}}
```

```json
{"kind":"edge_tombstone","data":{
  "id":"deal_1->acct_1:belongsTo",
  "deletedAt":"2026-08-12T09:15:00Z"
}}
```

### Payload schema

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | Id of the deleted record, in its own plane's id space |
| `deletedAt` | RFC 3339 UTC | yes | When the deletion happened **at the source** |
| `author` | `AuthorStamp` | no | Omitted when unknown. **Advisory only** — never used to decide a conflict |

`AuthorStamp` is unchanged from v0.1 (`userId`, optional `tokenId`,
`subjectType`, `authoredAt`).

### Which planes may be tombstoned

**Vertices and edges only.** These are the mutable graph planes, where
deletion is an ordinary operation.

Deliberately excluded, with reasons a binding author should preserve:

- **Observations** are append-only by design. An observation asserts
  that something was seen at a time; un-saying it destroys the audit
  trail the format exists to carry.
- **Evidence** is the justification other records cite. Deleting it
  strands its citers and makes the file fail closure verification.
- **Beliefs** are derived state; re-materialising regenerates them.

If retraction is ever wanted on those planes, it should be a distinct
`retraction` record carrying a *reason* — different semantics from a
delete, and a separate spec change.

### Conflict rules (implement exactly)

1. **Unknown id → no-op, not an error.** Imports must converge from any
   starting point, and a file may legitimately carry a deletion whose
   creation this destination never saw.
2. **A live record for the same id in the same file beats the
   tombstone.** It means the source re-created the thing after deleting
   it, so the live copy is the newer truth. **Consequence for
   implementers: apply tombstones only after the whole file has been
   read**, never inline — otherwise the outcome depends on line order.
3. **Apply edge tombstones before vertex tombstones.** Deleting a vertex
   cascades to its edges, so doing vertices first double-counts.
4. **Ties go to the tombstone**, so a delete is not lost to clock
   granularity.

### Known boundary (please carry this into the spec)

The comparison in rule 2 is **within the file**, not against the
destination's write history. Re-importing an *older* file after a newer
delete will resurrect the record, because nothing durable records "this
id was deleted at T" locally. Closing that needs a persistent tombstone
store on the destination and is **not** part of v0.2.

### Tombstone retention: 90 days

**A tombstone is retained for 90 days from `deletedAt`.** After that it
is swept, and an export produced from that point on no longer carries
it.

This is the existing engine default, not a new number invented for the
format: `DEFAULT_TOMBSTONE_TTL_MS` in
the reference server's reasoning defaults, overridable per
deployment via `ANTARES_TOMBSTONE_TTL_MS` and applied by the background
sweep in `worker.rs`. An operator who shortens it shortens the
trust window below by the same amount; the rule below is stated in terms
of the configured value, and 90 days is what it is out of the box.

The consequence is the part to write down: **a `.ant` file older than
the retention window can no longer be trusted to reflect deletions.**
Its live records are still accurate as of its export time, but a record
deleted at the source shortly after that export may have had its
tombstone swept before any later file could carry it. Importing an
ancient file is an additive operation with a blind spot, not a full
reconciliation.

The recovery path for anything outside the window is **re-reading the
source**, not trusting an old export. That is a deliberate design
position, not a limitation being apologised for, and the reasoning
should inform anything else built here:

> Antares is a **world model, not a system of record.** It duplicates
> what already lives in the customer's systems and never writes back to
> them. A deletion in this graph means "no longer part of the model we
> hold" — not "destroy the customer's data." Their file is untouched in
> SharePoint, their row is untouched in Salesforce.

So the cost of a missed tombstone is a stale entry in a derived model,
correctable by re-reading the source that still holds the truth. It is
not data loss. Retention windows are sized against that, which is why 90
days is generous rather than a compromise — and why unbounded tombstone
retention would be paying real storage for a problem a re-sync already
solves.

Implementations do **not** need to enforce the window to be conformant;
readers never see it. It constrains **producers** (when a tombstone may
be dropped) and **operators** (how old a file may be before a re-sync
beats an import).

### Where tombstones come from

The graph store keeps no delete history — a deleted vertex is simply
gone — so a re-export cannot distinguish "never existed" from "was
deleted" by inspecting current state. The reference implementation
derives them from the **operation log**, which records delete endpoints
with payload and timestamp. Ids that are present again are skipped:
they were re-created, and the live record is newer.

A binding that only *reads* `.ant` files needs none of this. A binding
that *writes* them needs some equivalent source of deletion history.

---

## 3. Trailer additions

`counts` gains two fields:

```json
{"kind":"trailer","counts":{
  "schemaTypes":0,"vertices":1,"edges":0,"observations":1,
  "evidence":1,"beliefs":1,"vectors":1,
  "vertexTombstones":2,"edgeTombstones":1
},"sha256":"…"}
```

| field | type | notes |
|---|---|---|
| `vertexTombstones` | uint64 | **Default 0 when absent** |
| `edgeTombstones` | uint64 | **Default 0 when absent** |

Both MUST default to zero when missing, so a v0.1 trailer still
deserializes under a v0.2 reader. In the JSON Schema, make them optional
with `"default": 0`.

The `sha256` semantics are unchanged: SHA-256 over every emitted line
including its trailing `\n`, in order, excluding the trailer line
itself. Tombstone lines participate exactly like any other record.

---

## 4. Manifest additions

No *required* additions. `selection` — already a free-form object in
v0.1 — carries more keys now. All optional; a reader that ignores them
is still conformant.

| key | type | meaning |
|---|---|---|
| `derivedFromClosure` | bool | Observations cited by `belief.derivedFrom` were included |
| `objectIdClosure` | bool | Vertices named by observation `subjectId`/`objectId` were included |
| `subjectlessObservationsExcluded` | uint64 | Count of observations with no `subjectId`, excluded from a seed selection because they have no position in a vertex-reachability set |
| `unresolved` | string[] | Ids the producer could not resolve, e.g. `"evidence:ev_9"`. **Disclosed, not hidden** |
| `strict` | bool | The export would have failed rather than emit `unresolved` |

`unresolved` matters for validators: an id listed there is a *declared*
gap, not a dangling reference, and should not be reported as a closure
failure.

---

## 5. Conformance

Goldens in `conformance/golden/` were regenerated at v0.2.
`expected.json` carries the new trailer counts. A v0.1 reader must still
read the v0.2 goldens under the policy in §1 — that is the single best
end-to-end check that the policy was applied correctly.

Two fixtures were added to the corpus and are generated by
`cargo run -p antares-format --example gen_conformance`:

- **`tombstones.ant`** — a v0.2 file with a live vertex and edge
  followed by a tombstone on each plane. The vertex tombstone carries an
  author stamp and the edge tombstone omits one, so both shapes are
  exercised. This fixture exists because a binding that treats the two
  new kinds as *unknown* still **verifies** the file — unknown kinds are
  hashed and skipped — so it would look correct while dropping every
  deletion on the floor. Nothing else in the corpus catches that.
- **`major_version.ant`** — a stream declaring v1.0 that is valid in
  every other respect, so the only reason to reject it is the major
  version. Listed in the new `golden/expected_negatives.json` rather
  than `expected.json`, so runners can keep iterating the latter as
  "files that must read" with no special-casing. The contract is
  deliberately just `mustReject`: error TEXT differs per implementation
  and pinning it would make the fixture untestable outside Rust.

Minor-forward reading is covered twice: `forward_compat.ant` proves an
unknown kind is skipped-but-hashed, and each runner synthesizes a
minor-ahead file to prove it reads and reports `minorAhead`. That second
check must **recompute the trailer hash** after rewriting the manifest,
or it fails as a sha256 mismatch and proves nothing about versioning.

### The in-repo bindings were broken by the version bump — a worked example

The warning in §1 is not hypothetical. The reference Python and JS
bindings gated on `version == "0.1"`, so the moment the goldens were
regenerated at v0.2 **every conformance check failed at the first
file**, with `unsupported format version 0.2 (reader supports 0.1)`.
The suite could not even reach the tombstone tests.

Both bindings have been brought to v0.2 alongside this document —
major/minor parsing, `minorAhead` on the reader and the summary, the two
new record kinds, and the two new trailer counts defaulted to zero so a
v0.1 trailer still validates. `schema/ant.schema.json` needed the same
treatment: its `counts` object had `additionalProperties: false`, which
rejected every v0.2 trailer, and the tombstone kinds had to be added to
`unknown_kind`'s exclusion list or a tombstone record matches two
branches of the top-level `oneOf`.

**Do the version-policy work before the version bump reaches your
readers, not after.** That ordering is the single most useful thing in
this document.

**Rule for anyone touching the version again: every binding must be
updated in the SAME commit as the version bump.** Not the next commit,
not a follow-up ticket. The Rust test suite structurally cannot catch a
stale binding — the Python and JS runners are not `cargo test`, they are
separate processes invoked by CI — so a bump that lands without them
leaves every non-Rust reader broken, and green Rust tests say nothing
about it. That is exactly how this one got through.

---

## 6. Proposal: a `convert` subcommand (not built)

Unscoped on purpose — nobody has picked a target. Options, with honest
costs. Estimates are engineering time for a competent implementer
already familiar with the codebase.

### The direction question comes first

**Import** (foreign → `.ant`) grows the funnel: it is how someone's
existing data gets in. **Export** (`.ant` → foreign) serves the
no-lock-in promise: it is how they leave, and how they hand data to a
tool that will never speak `.ant`. These have different buyers, and the
answer decides the ordering.

### Candidates

**JSON-LD / RDF (N-Quads) — export. ~1–2 weeks.**
The natural fit: the model is already a labelled property graph with
typed vertices, and OpenSPG lineage means an RDF-shaped view is
expected. Vertices → subjects, properties → literal predicates, edges →
object predicates. Buys interoperability with every SPARQL tool and
makes the graph loadable into Neo4j/Oxigraph/GraphDB. The real work is
not the mapping, it is the **reification** problem: `.ant`'s value is
per-fact evidence, confidence and bitemporal validity, and plain RDF
triples have nowhere to put them. RDF-star or named graphs solve it at
the cost of a much narrower set of tools that can consume the result.
Decide that trade before writing code.

**CSV — export. ~3–5 days.**
Cheapest by a wide margin and the most requested in practice, because
the destination is a spreadsheet or a data-warehouse `COPY`. One file
per plane (`vertices.csv`, `edges.csv`, …), properties flattened to
columns with a JSON blob for the irregular tail. Lossy by construction —
nested properties, per-property HLC, and tombstones do not survive — so
it must be labelled a *view*, not a round-trippable export. That
limitation is also why it is cheap.

**OpenSPG — both directions. ~3–4 weeks.**
Highest strategic value and highest cost. This repo already implements
the 10-endpoint KAG contract, so the schema mapping is largely known
work. It would let a customer migrate off OpenSPG into Antares — the
most direct competitive lever available. But it needs a live OpenSPG to
test against, the schema commit path (`knext`) is finicky, and the
semantics are close enough to be treacherous: the temporal and evidence
planes have no OpenSPG equivalent and would need a documented lossy
mapping.

**Parquet — export. ~1 week.**
Worth naming because it is where CSV requests actually end up once the
data is large. Same per-plane shape as CSV, but typed, columnar,
compressed, and directly queryable by DuckDB/Spark/Athena. Strictly
better than CSV for any analytical use; worse for the person who wanted
to open it in Excel.

### Recommendation

**CSV first, then Parquet, then JSON-LD. OpenSPG only if a named
customer is blocked on it.**

Reasoning: CSV is a few days, unblocks the most common real request
("can I get this into a spreadsheet / warehouse"), and needs no design
decisions we have not already made. Parquet reuses the same per-plane
flattening and covers the serious analytical case. JSON-LD is the
architecturally interesting one but its central question — how to
represent evidence and confidence — is a modelling decision that
deserves its own discussion, not a default. OpenSPG is the biggest prize
and the biggest cost, and it should be pulled by a specific deal rather
than pushed on spec.

One shape note if any of this gets built: `convert` should read `.ant`
through the same `AntReader` the rest of the toolchain uses and never
re-derive the format, for the same reason the HTTP export reuses
`ant_io` — one implementation, one set of guarantees.
