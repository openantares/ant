# OpenAntares `.ant` Format — Specification v0.1

Status: normative for format version `0.1`. This document plus
[`schema/ant.schema.json`](schema/ant.schema.json) are the source of
truth for the container; every implementation (the Rust crate
`antares-format`, the reference bindings under [`bindings/`](bindings/),
and any third-party reader/writer) must pass the
[conformance suite](conformance/) against them.

## 1. Purpose

`.ant` is a self-contained, compressed, streamable container for
exchanging a *selection* of an Antares world model: schema types,
vertices, edges, observations, evidence (structured and unstructured
data ride together), beliefs, and vector documents. Design goals, in
priority order:

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
{"kind":"trailer","counts":{...},"sha256":"..."}      exactly one, LAST line
```

Every line is a JSON object with a string field `kind`. Data records
(anything that is not `manifest`/`trailer`) may appear in any order and
any multiplicity, including zero.

File identification: the zstd magic **plus** a first record with
`kind == "manifest"`, `format == "antares"`, and a supported `version`.

## 3. The manifest (first line)

| field       | type            | required | meaning |
|-------------|-----------------|----------|---------|
| `kind`      | `"manifest"`    | yes      | |
| `format`    | `"antares"`     | yes      | belt for the zstd-magic braces |
| `version`   | string          | yes      | container layout semver; this spec is `"0.1"` |
| `tenantId`  | integer         | yes      | origin tenant |
| `projectId` | integer         | yes      | origin project |
| `selection` | any JSON        | no       | what was selected (whole scope, seed query, digest params). Recorded **verbatim, not interpreted** |
| `createdAt` | RFC 3339 string | no       | |
| `producer`  | string          | no       | tool/server identifier |

A reader MUST reject a stream whose first line is not a manifest, whose
`format` is not `"antares"`, or whose `version` it does not support.
A duplicate manifest anywhere later in the stream is an error.

## 4. Data records

Each data record is `{"kind":"<kind>","data":{...}}`. The `data`
payloads are the canonical JSON encodings of the corresponding Antares
core types — exactly the encoding the store uses, so an export is a
faithful byte-level snapshot. Field-name casing is therefore **mixed
by design** and normative:

- the record **envelope**, `manifest`, `trailer.counts`, and the
  `vector` payload use **camelCase** (`tenantId`, `schemaTypes`,
  `recordType`, `textPreview`);
- the `vertex`/`edge`/`observation`/`evidence`/`belief` payloads use
  **snake_case** (`src_type`, `subject_id`, `observed_at`,
  `value_json`, `evidenced_by`) — the core-model encoding.

Property values are untagged scalars (a `Long` is a JSON number, a
`Text` a JSON string, a `Json` value verbatim). The JSON Schema in
`schema/ant.schema.json` specifies the required fields per kind;
**unknown fields inside `data` MUST be preserved-or-ignored, never an
error** (additive evolution).

Kinds defined in v0.1:

| kind          | payload                                            |
|---------------|----------------------------------------------------|
| `schema_type` | ontology type: name, kind, properties, relations   |
| `vertex`      | graph entity: id, name, label, typed properties    |
| `edge`        | graph relation: id, src/dst + types, label, properties, provenance |
| `observation` | append-only fact: subject, predicate, object, times, confidence, evidence ids |
| `evidence`    | source material: provenance + verbatim content (structured AND unstructured together) |
| `belief`      | current interpretation: subject, predicate, value, version, supersession metadata |
| `vector`      | embedding doc: record ref, label, field, float array. Vectors MUST ride in exports when the origin server does not persist vector indexes |

## 5. The trailer (last line) and integrity

```
{"kind":"trailer","counts":{"schemaTypes":N,"vertices":N,"edges":N,
 "observations":N,"evidence":N,"beliefs":N,"vectors":N},"sha256":"<hex>"}
```

- `sha256` is the lowercase-hex SHA-256 over **every preceding
  uncompressed line including its trailing `\n`** — from the manifest
  line through the last data record line. The trailer line itself is
  not covered (it cannot contain its own hash).
- `counts` are the number of data records **per kind** actually
  present. Unknown-kind records are NOT counted (they are hashed —
  they are part of the byte stream — but a v0.1 reader cannot
  attribute them to a kind; writers of future kinds bump the format
  version if they need counted records).

A reader MUST:

1. fail if the stream ends without a trailer (truncation),
2. fail if the trailer `sha256` does not equal the hash it computed
   over the preceding lines,
3. fail if the trailer `counts` do not match the records it saw
   (excluding skipped unknown kinds),
4. treat everything after the trailer line as an error.

## 6. Forward compatibility

- A record whose `kind` is a string the reader does not recognize MUST
  be **skipped silently** (but still hashed — it is part of the byte
  stream).
- A line that is not a JSON object, or lacks a string `kind`, is a
  hard error.
- New fields on known kinds are additive; readers use defaults.
- Breaking layout changes bump `version`; readers reject versions they
  do not support rather than guessing.

## 7. Selection semantics (writer-side contract)

A `.ant` file carries whatever selection the exporter chose (whole
scope, a seed set + traversal, a digest). The manifest records the
selection descriptor verbatim so the consumer knows what the file
*claims* to contain. **Evidence closure is the exporter's obligation:**
every `evidence_id` referenced by an exported observation/edge/belief
should have its `evidence` record included in the same file.

## 8. Reference implementations

| language | location | role |
|----------|----------|------|
| Rust     | `antares-format` crate (Antares engine repository) | canonical writer/reader (the server and CLI use it) |
| Python   | `bindings/python/openantares.py` | reference reader + writer + validator |
| JavaScript (Node ≥ 22.15) | `bindings/js/openantares.mjs` | reference reader + validator |

All three run the same [conformance suite](conformance/README.md)
against shared golden files produced by the Rust writer.
