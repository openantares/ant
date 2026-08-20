# OpenAntares conformance suite

Golden `.ant` files produced by the canonical Rust writer, plus one
runner per implementation. Every implementation must:

1. read and fully verify the goldens (trailer sha256 + counts),
2. report the expected manifest scope, record sequence, and counts
   (`golden/expected.json`),
3. skip unknown record kinds while still verifying
   (`forward_compat.ant` carries a `hologram` record),
4. surface `vertex_tombstone` / `edge_tombstone` as records and count
   them (`tombstones.ant`) — a binding that treats them as unknown
   kinds still VERIFIES the file, so it would look correct while
   dropping every deletion on the floor,
5. reject the negative goldens listed in `golden/expected_negatives.json`
   (`major_version.ant` declares v1.0 and is valid in every other
   respect, so a 0.x reader must refuse it for the VERSION),
6. read a file whose MINOR is ahead of the reader, and report that it
   saw a subset — this is the rule most often implemented as
   `version == "0.2"`, which passes every positive test while being
   wrong,
7. reject the synthesized negatives: tampered record bytes, missing
   trailer, chopped compressed stream, data after the trailer, wrong
   counts, a different MAJOR version, an unparsable version, non-zstd
   input.

Format version: **0.3**. [`../SPEC.md`](../SPEC.md) is normative. The
engine repo's `docs/specs/ant-v0.3-delta.md` and `ant-v0.2-delta.md`
record what changed at each bump and the order to apply it in; the spec
supersedes them where they differ.

**v0.3 — SQL property types.** The v0.2 scalar set
(`null | bool | number | string | object`) could not express DECIMAL,
DATE, TIME, TIMESTAMP, UUID or BLOB: all of them are JSON strings, so a
reader could not tell them apart from text and the type was lost on the
first round-trip. v0.3 leaves those five shapes byte-identical and adds
a tagged envelope, `{"$ant":"<type>","v":<payload>}`, for the typed
values — see `propertyValue` in `../schema/ant.schema.json` for the
exact set. An object is an envelope ONLY when it has exactly the keys
`$ant` and `v` and `$ant` names a known type, so a producer's own
document carrying a `$ant` field still round-trips as that document.

Two rules a conforming reader is most likely to get wrong, both
exercised by `basic.ant`:

- **A decimal is a string, and must not be parsed as a float.** The
  golden's `exact_amount` is `12345678901234567.89`, which an IEEE
  double cannot hold; an implementation that parses it as a number
  rounds it silently and produces a different value with no error.
- **A timestamp keeps its offset.** The golden's `signed_at` is
  `2026-08-10T09:00:00+02:00`. Normalizing it to `Z` on read loses the
  one thing that distinguishes TIMESTAMPTZ from TIMESTAMP.

Because the bump is additive, a v0.2 reader still reads a v0.3 file — it
just sees the envelopes as plain objects, which is exactly what the
"minor is ahead of this reader" signal is for.

The two runners in this repository, both of which you can run here:

| implementation | runner | negatives | schema check |
|----------------|--------|-----------|--------------|
| Python | `python3 run_conformance.py` | yes (7) | yes, when `jsonschema` is installed |
| JavaScript | `node run_conformance.mjs` | yes (7) | covered by the Python runner |

The goldens themselves are written by `antares-format`, the canonical
Rust implementation, which is upstream and not part of this repository.
Regenerating them is an upstream act reserved for deliberate format
changes; consuming them needs nothing but the runners above.
