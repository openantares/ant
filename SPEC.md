# OpenAntares `.ant` Format — Specification v0.3

Status: normative for format version `0.3`. This document plus
[`schema/ant.schema.json`](schema/ant.schema.json) are the source of
truth for the container; every implementation (the Rust crate
`antares-format`, the reference bindings under [`bindings/`](bindings/),
and any third-party reader/writer) must pass the
[conformance suite](conformance/) against them.

Change notes for the two bumps that produced this version live in the
engine repo: `docs/specs/ant-v0.2-delta.md` (version policy,
tombstones, trailer/manifest additions) and `docs/specs/ant-v0.3-delta.md`
(typed property values). This spec supersedes both; where they differ,
this document and the golden files win.

## 1. Purpose

`.ant` is a self-contained, compressed, streamable container for
exchanging a *selection* of an Antares world model: schema types,
vertices, edges, observations, evidence (structured and unstructured
data ride together), beliefs, vector documents, and deletions. Design
goals, in priority order:

1. **Open** — plain JSON records inside a standard zstd stream; a
   reader is ~100 lines in any language with zstd and SHA-256.
2. **Integrity-checked** — truncation and tampering are detectable in
   one pass, without a side channel.
3. **Streamable** — writers emit records as they go; readers process
   them without loading the file.
4. **Forward compatible** — old readers skip record kinds they do not
   know; additive fields never break a reader.

Integrity is a **checksum, not encryption**. The format is fully open;
confidentiality, when required, is an *optional* encryption envelope
around the file, never a property of the format itself.

## 2. Container framing

A `.ant` file is **one zstd-compressed stream** (standard zstd frame,
magic `28 B5 2F FD`). The decompressed payload is **NDJSON**: UTF-8
JSON objects, one per line, separated by a single `\n` (0x0A). The
final line also ends with `\n`.

```
{"kind":"manifest", ...}                              exactly one, FIRST line
{"kind":"schema_type","data":{...}}
{"kind":"vertex","data":{...}}
{"kind":"edge","data":{...}}
{"kind":"observation","data":{...}}
{"kind":"evidence","data":{...}}
{"kind":"belief","data":{...}}
{"kind":"vector","data":{...}}
{"kind":"vertex_tombstone","data":{...}}
{"kind":"edge_tombstone","data":{...}}
{"kind":"trailer","counts":{...},"sha256":"..."}      exactly one, LAST line
```

Every line is a JSON object with a string field `kind`. Data records
(anything that is not `manifest`/`trailer`) may appear in any order and
any multiplicity, including zero.

File identification: the zstd magic **plus** a first record with
`kind == "manifest"`, `format == "antares"`, and a supported `version`.

## 3. Version compatibility

`version` is `MAJOR.MINOR`. A bare `"1"` is read as `1.0`; anything
that is not two integers separated by a dot is a hard error — guessing
at a version is how a reader ends up misinterpreting a payload.

The rule, which a reader MUST implement:

- **Same MAJOR → readable, at any MINOR.** Minor bumps are additive by
  definition (new record kinds, new fields, new value encodings), and
  everything a reader already understood keeps its meaning.
- **Different MAJOR → reject.** The rejection message should name both
  the file's version and the reader's, and say that majors are not
  compatible.
- **A file whose MINOR is ahead of the reader MUST be readable, and the
  reader MUST expose that it is ahead** (a `minorAhead` flag on the
  read result, or equivalent). The reader saw the file; it saw a
  *subset* of what the file means. A caller that needs completeness can
  then refuse, and one that does not can proceed.

The failure this rule exists to prevent is a version gate written as
`version == "0.2"`. That passes every positive test while being wrong,
and it locks out every future file for no reason. v0.1 shipped with
exactly that bug.

## 4. The manifest (first line)

| field       | type            | required | meaning |
|-------------|-----------------|----------|---------|
| `kind`      | `"manifest"`    | yes      | |
| `format`    | `"antares"`     | yes      | belt for the zstd-magic braces |
| `version`   | string          | yes      | container layout `MAJOR.MINOR`; this spec is `"0.3"` |
| `tenantId`  | integer         | yes      | origin tenant |
| `projectId` | integer         | yes      | origin project |
| `selection` | any JSON        | no       | what was selected (whole scope, seed query, digest params). Recorded **verbatim, not interpreted** |
| `createdAt` | RFC 3339 string | no       | |
| `producer`  | string          | no       | tool/server identifier |

A reader MUST reject a stream whose first line is not a manifest, whose
`format` is not `"antares"`, or whose `version` it does not support per
§3. A duplicate manifest anywhere later in the stream is an error.

## 5. Data records

Each data record is `{"kind":"<kind>","data":{...}}`. The `data`
payloads are the canonical JSON encodings of the corresponding Antares
core types — exactly the encoding the store uses, so an export is a
faithful byte-level snapshot. Field-name casing is therefore **mixed
by design** and normative:

- the record **envelope**, `manifest`, `trailer.counts`, the `vector`
  payload, and **both tombstone payloads** use **camelCase**
  (`tenantId`, `schemaTypes`, `recordType`, `textPreview`,
  `deletedAt`);
- the `vertex`/`edge`/`observation`/`evidence`/`belief` payloads use
  **snake_case** (`src_type`, `subject_id`, `observed_at`,
  `value_json`, `evidenced_by`) — the core-model encoding.

Do not infer the casing of one kind from another; check the golden
files. `vertex` in particular carries only `id`, `name`, `label`,
`properties` — no tenant/project, which the manifest already scopes.

The JSON Schema in `schema/ant.schema.json` specifies the required
fields per kind; **unknown fields inside `data` MUST be
preserved-or-ignored, never an error** (additive evolution).

Kinds defined as of v0.3:

| kind               | since | payload |
|--------------------|-------|---------|
| `schema_type`      | 0.1   | ontology type: name, kind, properties, relations |
| `vertex`           | 0.1   | graph entity: id, name, label, typed properties |
| `edge`             | 0.1   | graph relation: id, src/dst + types, label, properties, provenance |
| `observation`      | 0.1   | append-only fact: subject, predicate, object, times, confidence, evidence ids |
| `evidence`         | 0.1   | source material: provenance + verbatim content (structured AND unstructured together) |
| `belief`           | 0.1   | current interpretation: subject, predicate, value, version, supersession metadata |
| `vector`           | 0.1   | embedding doc: record ref, label, field, float array. Vectors MUST ride in exports when the origin server does not persist vector indexes |
| `vertex_tombstone` | 0.2   | a deleted vertex: `id`, `deletedAt`, optional `author` |
| `edge_tombstone`   | 0.2   | a deleted edge: same shape |

### 5.1 Deletions (v0.2)

Import was additive-only in v0.1: deleting a vertex at the source and
re-exporting left the record alive at the destination forever, and the
two stores diverged with nothing able to detect it. Tombstones carry
the deletion.

Only the **vertex and edge** planes may be tombstoned. Observations are
append-only, evidence is cited by other records, and beliefs are
derived state — deleting any of those would break references that other
records still hold.

A tombstone payload is `{"id": ..., "deletedAt": <RFC3339>}` plus an
optional `author`.

On import, in this order:

1. **Edge tombstones are applied before vertex tombstones.** Deleting a
   vertex cascades to its edges exactly as a live delete does, so doing
   vertices first would make the edge accounting wrong.
2. **A tombstone whose id also appears as a LIVE record in the same
   file is skipped.** The file is self-consistent by construction: if
   it carries both a deletion and a live record for one id, the live
   record is the newer intent and wins.
3. **A tombstone for a record the destination does not have is a
   no-op**, not an error — the record may never have been imported
   there.
4. Otherwise the record is deleted.

Note that this is a within-file rule, not a timestamp comparison
against the destination store: `deletedAt` is carried for provenance
and audit, and importers are not required to compare it against stored
record times.

An importer should report how many deletions it applied, how many it
skipped as superseded, and how many named records it did not have —
otherwise "the import converged" cannot be distinguished from "the
import silently did nothing". The names of those counters are an
implementation's own API, not part of this format.

## 6. Property values

A property value is one of five bare JSON forms, or a tagged envelope.

**The five bare forms (v0.1, unchanged and byte-identical):**

| JSON            | meaning |
|-----------------|---------|
| `null`          | null |
| `true` / `false`| boolean |
| `42`            | 64-bit integer (BIGINT) |
| `1.5`           | double |
| `"hi"`          | text |
| `{...}` / `[...]` | a JSON/JSONB document value |

**The tagged envelope (added in v0.3)**, `{"$ant":"<type>","v":<payload>}`:

| tag         | payload | meaning |
|-------------|---------|---------|
| `decimal`   | string  | DECIMAL/NUMERIC. Canonical decimal literal |
| `date`      | string  | DATE, `YYYY-MM-DD` |
| `time`      | string  | TIME, `HH:MM:SS[.ffffff]` |
| `timestamp` | string  | TIMESTAMP WITH TIME ZONE, RFC3339 |
| `uuid`      | string  | UUID, lowercase 8-4-4-4-12 |
| `bytes`     | string  | BLOB/BYTEA, base64 (standard alphabet, padded) |
| `int32`     | integer | INT, range-checked |
| `int16`     | integer | SMALLINT, range-checked |
| `array`     | array   | elements are themselves property values |

v0.2 had only the bare forms, and they cannot express these types:
`DECIMAL`, `DATE`, `TIME`, `TIMESTAMP`, `UUID` and `BLOB` all serialize
as JSON strings, so a reader could not tell a date from a string that
looked like one and the type was lost on the first round-trip.

Writers **MUST NOT** wrap the five bare forms. `{"$ant":"long","v":42}`
is invalid: `42` is already unambiguous, and wrapping it would break
every v0.2 reader for no gain.

### 6.1 Recognising an envelope

An object is an envelope **only when it has exactly the two keys `$ant`
and `v`, and `$ant` names a tag from the table above.** Everything else
is an ordinary JSON document value and MUST round-trip as one:

```json
{"$ant":"decimal","v":"1.0","mine":true}   -> a document (three keys)
{"$ant":"wat","v":1}                       -> a document (unknown tag)
{"$ant":"date","v":"not-a-date"}           -> a document (payload does not parse)
```

The last case matters for durability: this decoding runs against data
that is already committed, so a malformed envelope degrades to a plain
JSON value rather than failing the read.

### 6.2 Two rules that silently corrupt data

Both are exercised by `golden/basic.ant`; an implementation that gets
them wrong still parses the file cleanly.

**A decimal is a string and MUST NOT be parsed as a float.** The
golden's `exact_amount` is `12345678901234567.89` — 19 significant
digits, where an IEEE double carries ~15–16. Parsed as a number it
becomes `12345678901234568`, with no error. This is why the payload is
a string, and why readers should surface it as text (or a decimal type)
rather than a native number. The same applies on write: do not accept a
fractional JSON *number* as a decimal, because your JSON parser has
already passed it through a double before you see it.

**A timestamp keeps its offset.** The golden's `signed_at` is
`2026-08-10T09:00:00+02:00`. Normalizing it to `Z` on read discards the
only thing that distinguishes TIMESTAMPTZ from TIMESTAMP. Compare
timestamps by instant; serialize the offset as given.

## 7. The trailer (last line) and integrity

```
{"kind":"trailer","counts":{"schemaTypes":N,"vertices":N,"edges":N,
 "observations":N,"evidence":N,"beliefs":N,"vectors":N,
 "vertexTombstones":N,"edgeTombstones":N},"sha256":"<hex>"}
```

- `sha256` is the lowercase-hex SHA-256 over **every preceding
  uncompressed line including its trailing `\n`** — from the manifest
  line through the last data record line. The trailer line itself is
  not covered (it cannot contain its own hash).
- `counts` are the number of data records **per kind** actually
  present. Unknown-kind records are NOT counted (they are hashed —
  they are part of the byte stream — but a reader cannot attribute them
  to a kind; writers of future kinds bump the MINOR version if they
  need counted records).
- `vertexTombstones` and `edgeTombstones` were added in v0.2. They MUST
  default to zero when absent, so a v0.1 trailer still validates.

A reader MUST:

1. fail if the stream ends without a trailer (truncation),
2. fail if the trailer `sha256` does not equal the hash it computed
   over the preceding lines,
3. fail if the trailer `counts` do not match the records it saw
   (excluding skipped unknown kinds),
4. treat everything after the trailer line as an error.

## 8. Forward compatibility

- A record whose `kind` is a string the reader does not recognize MUST
  be **skipped silently** (but still hashed — it is part of the byte
  stream).
- A line that is not a JSON object, or lacks a string `kind`, is a
  hard error.
- New fields on known kinds are additive; readers use defaults.
- New MINOR versions are readable per §3; only a MAJOR bump is a
  rejection.

## 9. Selection semantics (writer-side contract)

A `.ant` file carries whatever selection the exporter chose (whole
scope, a seed set + traversal, a digest). The manifest records the
selection descriptor verbatim so the consumer knows what the file
*claims* to contain. **Evidence closure is the exporter's obligation:**
every `evidence_id` referenced by an exported observation/edge/belief
should have its `evidence` record included in the same file.

## 10. Reference implementations

| language | location | role |
|----------|----------|------|
| Rust     | `antares-format` crate — canonical, upstream, not in this repository | writer that produces the goldens |
| Python   | `bindings/python/openantares.py` | reference reader + writer + validator |
| JavaScript (Node ≥ 22.15) | `bindings/js/openantares.mjs` | reference reader + validator |

All three run the same [conformance suite](conformance/README.md)
against shared golden files produced by the Rust writer.

**Any change to this document changes all of them.** The Rust test
suite structurally cannot catch a stale binding — the Python and JS
runners are separate processes, not `cargo test` — so a version bump
that lands without them leaves every non-Rust reader broken while Rust
stays green. That has happened twice. Update the bindings, the JSON
Schema, and the goldens in the SAME commit as the spec.
