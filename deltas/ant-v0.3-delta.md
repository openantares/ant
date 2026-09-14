# `.ant` v0.2 → v0.3 delta

For whoever applies this to the spec, the JSON Schema, and the Python /
JS bindings. Written to be sufficient on its own — you should not need
to read the Rust.

Reference implementation: `crates/ant-types/src/property.rs` (the value
type and its encoding), `crates/ant-types/src/decimal.rs` (exact
decimal), the `antares-format` crate (container).

**One change, one reason.** v0.2's property values were bare untagged
JSON: `null | bool | number | string | object`. That set cannot express
the SQL types. `DECIMAL`, `DATE`, `TIME`, `TIMESTAMP`, `UUID` and `BLOB`
all serialize as JSON strings, so a reader cannot tell a date from a
string that looks like one, and the type is lost on the first
round-trip. Storing a type you cannot read back is not parity. v0.3 adds
a tagged envelope for exactly those values and changes nothing else.

---

## 1. The five v0.2 shapes are UNCHANGED

This is the first thing to internalize, because it is what keeps the
bump additive.

| value | v0.2 JSON | v0.3 JSON |
|-------|-----------|-----------|
| null | `null` | `null` |
| boolean | `true` | `true` |
| BIGINT | `42` | `42` |
| DOUBLE | `1.5` | `1.5` |
| TEXT | `"hi"` | `"hi"` |
| JSON/JSONB document | `{"a":[1,2]}` | `{"a":[1,2]}` |

Byte-identical, both directions. These six variants had unambiguous JSON
shapes already, so there was nothing to fix and no reason to churn every
stored record and every client that reads one. **A v0.3 writer must not
wrap them.** If your implementation emits `{"$ant":"long","v":42}` it is
wrong, and every v0.2 reader will see an object where it expected a
number.

The tags below exist only for the values that had no distinguishable
JSON shape.

---

## 2. The envelope

```json
{"$ant": "<type>", "v": <payload>}
```

One example of each, all of which appear in the `basic.ant` conformance
golden:

```json
{"$ant":"decimal",   "v":"12345678901234567.89"}
{"$ant":"date",      "v":"2026-08-10"}
{"$ant":"time",      "v":"14:30:00.500000"}
{"$ant":"timestamp", "v":"2026-08-10T09:00:00+02:00"}
{"$ant":"uuid",      "v":"6ba7b810-9dad-11d1-80b4-00c04fd430c8"}
{"$ant":"bytes",     "v":"AAH+/w=="}
{"$ant":"int32",     "v":1200}
{"$ant":"int16",     "v":-7}
{"$ant":"array",     "v":["enterprise","renewal"]}
```

Payload rules:

- **decimal** — a canonical decimal STRING: optional sign, digits,
  optional fraction, optional `e±nn`. Trailing fraction zeros are
  SIGNIFICANT (they carry the declared scale): `12.3400` is scale 4 and
  is not the same column value as `12.34`.
- **date** — `YYYY-MM-DD`.
- **time** — `HH:MM:SS` with an optional fraction. The Rust writer emits
  a fixed 6-digit fraction so lexicographic order matches chronological
  order; readers must accept either.
- **timestamp** — RFC3339, offset included.
- **uuid** — 8-4-4-4-12, lowercase.
- **bytes** — base64, standard alphabet, padded.
- **int32 / int16** — JSON integers, range-checked. They are distinct
  from a bare number so a 32-bit column does not read back 64-bit.
- **array** — a JSON array whose elements are themselves property
  values, envelopes included. This is what keeps `Array<Decimal>` exact
  instead of degrading to an array of strings.

### The recognition rule — implement it exactly

An object is an envelope **only when it has exactly the two keys `$ant`
and `v`, and `$ant` names a known type.** Anything else is an ordinary
JSON document value and must round-trip as one.

```json
{"$ant":"decimal","v":"1.0","mine":true}   -> a document (3 keys)
{"$ant":"wat","v":1}                       -> a document (unknown tag)
{"$ant":"date","v":"not-a-date"}           -> a document (payload does
                                              not parse; preserve it,
                                              do not error)
```

The last one matters for durability: this decoding runs against data
that is already committed, so a malformed envelope degrades to a plain
JSON value rather than failing the read. Refusing it would mean losing a
record that is already on disk.

A producer whose own documents contain a `$ant` field therefore still
gets their document back. There is a test for precisely this in each
implementation; port it.

---

## 3. Two traps that will silently corrupt data

Both are exercised by `basic.ant`. An implementation that gets them
wrong still passes a naive "does it parse" check.

**A decimal is a string, and must never be parsed as a float.** The
golden's `exact_amount` is `12345678901234567.89` — 19 significant
digits, where an IEEE double carries ~15–16. Parse it as a number and
you get `12345678901234568`, with no error and no warning. This is why
the payload is a string in the schema and why the reference bindings
return it as text: `float()` in Python, `Number()` in JS and `as_f64` in
Rust are all the same mistake. Hand it to `decimal.Decimal` / a decimal
library / `ant_types::Decimal` if you need arithmetic.

The same applies on the way IN. Do not accept a fractional JSON *number*
as a decimal: by the time your JSON parser hands it to you it has
already been through a double, so `1.10` arrives as `1.1` with the scale
gone. The Rust deserializer refuses fractional JSON numbers outright and
tells the caller to send a string; integers are exact in every JSON
parser and are accepted.

**A timestamp keeps its offset.** The golden's `signed_at` is
`2026-08-10T09:00:00+02:00`. Normalizing it to `Z` on read throws away
the one thing that distinguishes `TIMESTAMPTZ` from `TIMESTAMP` — an
event stamped 09:00+02:00 happened at 9am where it happened. Compare
timestamps by INSTANT (so `12:00+02:00` equals `10:00Z`), but serialize
the offset as it was given. Offset-less input is read as UTC, since
there is nothing else it could mean.

---

## 4. Why this is a MINOR bump

Under the v0.2 compatibility policy (same major → readable, minor bumps
are additive), v0.3 qualifies:

- A v0.2 reader opens a v0.3 file without error.
- Every value it already understood is byte-identical.
- What it loses is the TYPE: an envelope decodes as a plain JSON object
  rather than as a decimal.

That last point is exactly what the "minor is ahead of this reader"
signal exists to communicate — the reader saw the file, and it saw a
subset of what the file means. No major bump is warranted, because
nothing a v0.2 reader could previously read has changed meaning.

Going the other way, a v0.3 reader reads a v0.2 file unchanged: with no
envelopes present, every value takes the legacy path.

---

## 5. JSON Schema

`schema/ant.schema.json` gains two `$defs` — `propertyValue` (the union)
and `propertyEnvelope` (the nine tagged arms) — and every `properties`
bag now points at `propertyValue` via `additionalProperties` instead of
being an open `{"type": "object"}`.

### The `oneOf` mistake — do not repeat it

The first version of this schema failed validation on the golden with
`is not valid under any of the given schemas`, which is a confusing way
for JSON Schema to say *two* branches matched.

`propertyValue` is a `oneOf` (exactly one arm), and it has both a
generic `{"type":"object"}` arm for JSON documents and an envelope arm.
An envelope is an object, so it matched **both** — and `oneOf` fails on
two matches just as it does on zero. The fix is to exclude envelopes
from the document arm:

```json
{ "type": "object", "not": { "$ref": "#/$defs/propertyEnvelope" } }
```

which also states the recognition rule from §2 declaratively.

This is the second time this exact shape of bug has landed in this
schema: v0.2 hit it when the tombstone kinds had to be added to
`unknown_kind`'s exclusion list, or a tombstone record matched two
branches of the top-level `oneOf`. **When you add a branch to any
`oneOf` in this file, check whether an existing permissive branch also
matches it.** If two can match, either narrow one with `not`, or use
`anyOf` and accept the weaker guarantee.

---

## 6. Bindings

**The rule from the v0.2 delta still stands, and it applies to this
bump: every binding must be updated in the SAME commit as the version
bump.** Not the next commit, not a follow-up ticket. The Rust test suite
structurally cannot catch a stale binding — the Python and JS runners
are separate processes, not `cargo test` — so a bump that lands without
them leaves every non-Rust reader broken while Rust stays green.

Both in-repo bindings have been brought to v0.3:

- `FORMAT_MINOR` 2 → 3 in `bindings/python/openantares.py` and
  `bindings/js/openantares.mjs` (plus the header docstrings). Without
  this they still READ v0.3 files — the v0.2 version policy is doing its
  job — but they report every current-version file as "minor ahead",
  which is wrong and would mislead anyone acting on that flag.
- `is_property_envelope` / `decode_property` / `encode_property` in
  Python, `isPropertyEnvelope` / `decodeProperty` / `encodeProperty` in
  JS. A container binding could technically skip these and hand back raw
  JSON, but then every consumer reimplements the recognition rule and
  half of them will get the strictness wrong. They return decimals and
  timestamps as TEXT, deliberately (see §3).

### Binding checklist

- [ ] Bump `FORMAT_MINOR` to 3.
- [ ] Recognize the envelope with the exact-two-keys + known-tag rule.
- [ ] Decode arrays element-wise.
- [ ] Return decimal / date / time / timestamp / uuid as text, bytes as
      base64 text. Never float, never a native `number`.
- [ ] Preserve a malformed or unknown-tag object as a plain document
      rather than erroring.
- [ ] Do NOT wrap the six legacy shapes on write.
- [ ] Run `run_conformance.py` and `run_conformance.mjs` (32/32 and
      27/27 at the time of writing).

---

## 7. Conformance

`golden/basic.ant` was regenerated at v0.3 and its `deal_1` vertex now
carries one value of every type, alongside the v0.2 values it already
had. The Rust suite gained
`basic_golden_carries_the_v0_3_typed_properties`, which asserts the
CONTENTS rather than just that the file parses — a vector nobody checks
the contents of proves only that the container is well-formed, which was
never the risk here.

Regenerate with:

```
cargo run -p antares-format --example gen_conformance
```

Deterministic by construction, so bytes change only when the format
does.

---

## 8. Not in this bump

`ValueType::Decimal` in the schema plane stays UNPARAMETERIZED — the
declared `(precision, scale)` remains in the source-schema mapping. The
value carries its own exact scale and reports its own precision, which
is enough for storage, comparison and round-tripping, and parameterizing
the variant would change its serde shape from the string `"Decimal"` to
a struct in every stored schema record.

The trigger to revisit is written down at the declaration in
`crates/ant-types/src/schema.rs`: when the SQL auto-mapper needs to
VALIDATE values against declared column types — rejecting a scale-6
value written into a `DECIMAL(10,4)` column — the declaration has to
live there, because that check cannot be made from the value alone.
