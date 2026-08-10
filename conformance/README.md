# OpenAntares conformance suite

Golden `.ant` files produced by the canonical Rust writer, plus one
runner per implementation. Every implementation must:

1. read and fully verify the goldens (trailer sha256 + counts),
2. report the expected manifest scope, record sequence, and counts
   (`golden/expected.json`),
3. skip unknown record kinds while still verifying
   (`forward_compat.ant` carries a `hologram` record),
4. reject the synthesized negatives: tampered record bytes, missing
   trailer, chopped compressed stream, data after the trailer, wrong
   counts, unsupported future version, non-zstd input.

| implementation | runner | negatives | schema check |
|----------------|--------|-----------|--------------|
| Rust (`antares-format`) | `cargo test -p antares-format --test conformance` | covered by the crate's unit tests | n/a (serde types ARE the shapes) |
| Python | `python3 run_conformance.py` | yes (7) | yes, when `jsonschema` is installed |
| JavaScript | `node run_conformance.mjs` | yes (7) | covered by the Python runner |

Golden regeneration (deliberate format changes only):

```sh
cargo run -p antares-format --example gen_conformance
```
