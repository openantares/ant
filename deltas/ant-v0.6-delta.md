# `.ant` v0.5 → v0.6 delta

For whoever applies this to the spec, the JSON Schema, and the Python /
JS bindings. Written to be sufficient on its own — you should not need
to read the Rust.

Reference implementation: `crates/ant-types/src/event_time.rs` (the
`EventTime` type and its wire form), `crates/ant-types/src/observation.rs`
(the two fields that now carry it), the `antares-format` crate (container).
The reference server's writer, importer, sync-apply, replay and every
time-aware reader agree on the one unknown state.

**One shape change, one reason.** An observation requires two times:
`observed_at` (the EVENT time — when the thing happened) and
`extracted_at` (the PROVENANCE time — when an extractor produced the
record). Through v0.5 both were required bare RFC3339 strings, so a
genuinely dateless original — a model claim drawn from prose that names
no business date — could not be represented at all. 2,664 such originals
were held back in a local journal instead of the graph, leaving 7,990
references to them dangling. v0.6 makes the unknown state first-class,
end to end, WITHOUT re-encoding any dated record.

---

## 1. The field shape

`observed_at` and `extracted_at` are each an **event time** with three
disjoint wire forms:

```
"observed_at": "2026-08-09T10:00:00Z"                         Known, no basis
"observed_at": {"known":{"at":"2026-08-09T10:00:00Z",         Known, with a basis
                         "basis":"source_record_time"}}
"observed_at": {"unknown":{"reason":"no_source_time"}}         Unknown
```

Rules:

- **A bare RFC3339 string is a Known time with no basis, and is
  byte-identical to v0.5.** This is the whole reason the bump is a
  MINOR, additive one: every dated observation in every v0.5 file reads
  and re-exports unchanged. Nothing re-serializes the ~131k historical
  dated observations, and nothing fabricates a `basis` onto them.
- **`{"known":{"at",…,"basis":…}}`** is a Known time whose `basis`
  records how the instant was arrived at. `basis` is one of
  `source_record_time`, `asserted_valid_from`, `source_field_binding`.
- **`{"unknown":{"reason":…}}`** is explicitly unknown. `reason` is one
  of `no_source_time`, `asserted_without_date`, `current_state_only`,
  `ambiguous_source_time`, `implausible_source_time`. Unknown is **not
  null and not a sentinel** — it carries a reason, and no reader may
  substitute `epoch`, `now` or `0`.
- **Event time is never fabricated; provenance time may carry a basis.**
  A producer MAY populate `extracted_at` (provenance) as
  `{"known":{"at":…,"basis":…}}` from an extraction receipt. Nothing may
  invent an `observed_at` (event) the source did not carry — a source
  with no event time yields `{"unknown":{"reason":"no_source_time"}}`.
- **The vocabulary is shared, not invented.** `Known`/`Unknown`, the
  three `basis` names and the five `reason` names are reused verbatim
  from the engine's process-mining `EventTime` (PRODUCT-209). One
  dialect, not two.

The three forms are disjoint by construction — a JSON string, an object
keyed `known`, an object keyed `unknown` — so decoding is unambiguous in
both directions and self-describing.

## 2. Time-aware readers — the semantic rule

An `unknown` time is on **no timeline**. A time window, a time-ordered
index, a "most-recent" read:

- MUST exclude an observation whose `observed_at` is `unknown` — it is
  in no window, including one that opens at the epoch. It is never
  clamped to a bound.
- MUST NOT surface it in a time-ordered result.

The observation remains fully present in the main plane, in unordered
listings, in the `.ant` archive (which iterates the record column, not
the time index) and in replay. The risk this rule guards is the
opposite of the old one: not that an undated original is dropped, but
that it silently materialises at the epoch or at `now`.

Ordering, where a total order is needed: every `Known` sorts before
every `Unknown` (known by instant, unknown by reason), so a time-sorted
plane is deterministic and dateless records land together at one end
rather than at the epoch.

## 3. Trailer and readers

The trailer is unchanged — no new count key, no new record kind. An
observation is still one `observation` record; only the encoding of two
of its fields gained forms.

This is a MINOR bump. A v0.6 reader reads every v0.5 file unchanged. A
v0.5 reader reads every observation in a v0.6 file whose times are bare
strings exactly as before, and errors only on an observation that uses
one of the two object forms — which is exactly the "the file is ahead of
this reader" signal §3 of the spec describes. (Unlike v0.2–v0.5, the new
capability is a field encoding rather than a new record kind, so it is
not skippable the way an unknown kind is — an older reader that meets the
new form on a record it must read fails loudly rather than silently
dropping it.)

## 4. JSON Schema

`schema/ant.schema.json` (same `$id`; title now "format 0.6") is
REGENERATED from the Rust types by
`cargo run -p antares-format --features schemars --example gen_schema`
— never hand-edited (PRODUCT-239). The regeneration adds:

- `$defs.event_time`: an `anyOf` of the three wire forms — a
  `date-time` string, `{"known":{at,basis}}`, `{"unknown":{reason}}`;
- `$defs.known_body_schema` (`at` + `basis` enum) and
  `$defs.unknown_body_schema` (`reason` enum);
- the `observation` arm's `observed_at` and `extracted_at` now `$ref`
  `event_time` instead of a bare `date-time` string.

Because the bare-string branch stays first in the `anyOf`, every v0.5
golden line still validates. No `oneOf`/`unknown_kind` trap this time:
the change is a field encoding, not a new top-level kind.

## 5. Bindings checklist (same commit, standing rule)

- [x] `FORMAT_MINOR` 5 → 6, `FORMAT_VERSION` "0.6" (generated into both
      bindings' format-facts region from the Rust constants).
- [x] No new count key and no new data kind — the counts/kinds regions
      are unchanged by this bump.
- [x] The reference bindings decode a record's `data` generically, so
      the new field forms ride through as ordinary JSON; the conformance
      runners additionally decode and assert the event-time STATE (see
      §6) so a binding that could not read the object form fails.
- [x] `run_conformance.py` and `run_conformance.mjs` green.

## 6. Conformance

`golden/unknown_time.ant`: two observations that pin the whole additive
contract in one file —

- `obs_undated` — a genuinely dateless original. Its EVENT time is
  `{"unknown":{"reason":"no_source_time"}}` (never a fabricated
  instant); its PROVENANCE time is
  `{"known":{"at":…,"basis":"source_record_time"}}`, the basis drawn
  from the extraction receipt. This is the record that could not exist
  before v0.6;
- `obs_dated` — an ordinary dated observation whose `observed_at` and
  `extracted_at` are bare RFC3339 strings, byte-identical to v0.5.
  Pinning it here is the proof the bump is additive: the common case did
  not move.

The runners check `observedTimeStates` (`["unknown","known"]`),
`extractedTimeBases` (`["source_record_time", null]` — the dated one's
bare string carries no basis) and `unknownReasons` (`["no_source_time"]`)
by DECODING each observation's time, not by counting records — so a
binding that could not read the v0.6 wire form fails rather than passes.
Every line of the golden is validated against the regenerated schema, so
the schema's acceptance of all three forms is checked too. Every other
golden was regenerated at v0.6; their bytes change only by the manifest
version and the retrailered hash.

Redaction audit of the new fixture (pre-publication): every id, uri,
predicate and value is synthetic — a fictional `deal_1` subject, a
`headcount` observation valued `1200`, sources `antares://filing/7` and
`antares://mail/9` — and the decompressed lines carry no e-mail
addresses, phone numbers, credentials or person names.

## 7. Not in this bump

- Any change to `edge`, `belief` or `evidence` times: their
  `observed_at`/`extracted_at` remain `Option<timestamp>` and are
  untouched. Only `observation` gained the event-time shape.
- The OpenSPG-compatible `/public/v1` surface: it does not project
  observation event times, and this bump leaves its wire shapes
  byte-for-byte unchanged.
- A typed OpenAPI schema for the field on the internal `/v1/antares`
  DTO: the field is described as a free JSON value there (it is one of
  three shapes); a per-shape client type is a separate decision.
- Publishable crate versions (`ant-types`, `antares-format`,
  `openantares`): a release-prep decision, made separately as it was for
  v0.3–v0.5.
