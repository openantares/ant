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
conformance/                  golden files + runners for all three implementations
```

The canonical implementation is the `antares-format` Rust crate in the
Antares engine repository — the server and CLI use it, and it generates
the conformance goldens.

## Running the conformance suite

```sh
# 1. Rust (canonical) — run in the Antares engine repository
cargo test -p antares-format --test conformance

# 2. Python reference binding (pip install zstandard; jsonschema optional
#    but enables per-line schema validation)
python3 conformance/run_conformance.py

# 3. JavaScript reference binding (Node >= 22.15)
node conformance/run_conformance.mjs
```

Regenerating goldens (in the engine repository; only when the format
deliberately changes):

```sh
cargo run -p antares-format --example gen_conformance
```

The generator is deterministic — fixed ids and timestamps, no clock —
so a diff in the golden bytes always means a format change.

## Versioning

The container version lives in the manifest (`"version": "0.3"`) as
`MAJOR.MINOR`. Readers accept any MINOR at the same MAJOR and report
when a file is ahead of them; a different MAJOR is rejected. Unknown
record kinds and additive fields inside known kinds are
forward-compatible by specification (see SPEC.md §3 and §8).

## License

Apache-2.0 (see [LICENSE](LICENSE)), matching `antares-format`.
