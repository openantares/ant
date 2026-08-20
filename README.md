# OpenAntares

The open-release track of the Antares `.ant` interchange format:
specification, machine-readable schema, reference bindings, and a
cross-language conformance suite.

## Layout

```
SPEC.md                       the normative format specification (v0.3)
schema/ant.schema.json        JSON Schema for every record line (source of truth
                              for record shapes; SPEC.md owns container rules)
bindings/python/openantares.py   reference reader + writer + validator (needs `zstandard`)
bindings/js/openantares.mjs      reference reader + validator (Node >= 22.15, native zstd)
conformance/                  golden files + the two runners you can run here
```

## Running the conformance suite

Both runners in this repository work against the golden files as
checked in, with no other setup:

```sh
# Python reference binding. `pip install zstandard`; `jsonschema` is
# optional and adds per-line validation against schema/ant.schema.json.
python3 conformance/run_conformance.py

# JavaScript reference binding. Node >= 22.15, which is where
# node:zlib gained native zstd — earlier versions cannot start it.
node conformance/run_conformance.mjs
```

Each one reads and fully verifies every golden, rejects the negative
fixtures, and checks that a newer MINOR stays readable. They are also
the contract for a third-party implementation: pass these against
these goldens and your reader is conformant.

## The goldens and where they come from

The canonical implementation is a Rust crate, `antares-format`. It is
the writer that produced the golden files, and it is upstream of this
repository — the spec, schema, bindings and goldens here are published
from it. It is not part of this repository and you do not need it: the
goldens are bytes, and the two runners above verify them.

The generator is deterministic — fixed ids and timestamps, no clock —
so a diff in the golden bytes always means a deliberate format change.

## Versioning

The container version lives in the manifest (`"version": "0.3"`) as
`MAJOR.MINOR`. Readers accept any MINOR at the same MAJOR and report
when a file is ahead of them; a different MAJOR is rejected. Unknown
record kinds and additive fields inside known kinds are
forward-compatible by specification (see SPEC.md §3 and §8).

## License

Apache-2.0 — see [LICENSE](LICENSE).
