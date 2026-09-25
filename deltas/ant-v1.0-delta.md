# `.ant` v0.7 → v1.0 delta

v1.0 is v0.7 plus **stored originals**: a primary `evidence` record may
name the exact file it was cut from, and the file's bytes travel with it
as `original_chunk` records. Nothing else changes; every other record
keeps its v0.7 shape and bytes.

## 1. Why a major

A 0.x reader skips record kinds it does not know and ignores fields it
does not know — the additive rule every minor relies on. For originals
that rule is the failure: a 0.x reader would import each evidence and
drop its original without a word. A different major is refused at the
manifest, before any record, so a 0.x reader refuses a v1.0 file instead
of importing it incomplete.

**Writers use 1.0 only when the file carries an original.** A selection
without one is written as v0.7, byte for byte as before. A v1.x reader
reads both majors.

## 2. The reference

`evidence.data.source_blob` (optional; absent on every other record):

```json
{"assetId": "asset_original_0001", "byteLength": 150,
 "sha256": "<64 lowercase hex>", "mediaType": "application/pdf",
 "fileName": "ev_original.pdf"}
```

## 3. The bytes

The evidence is followed immediately by its chunks, in order, before any
other record:

```json
{"kind":"original_chunk","data":{"evidenceId":"ev_original",
 "assetId":"asset_original_0001","index":0,"byteOffset":0,
 "sha256":"<chunk hex>","bytes":"<standard base64>"}}
```

Readers enforce: no other record between an evidence and its last chunk;
contiguous `index` and `byteOffset`; every chunk decodes and matches its
`sha256`; all chunks but the last have the first's length and the last
is no longer; the total is `byteLength` and the whole matches `sha256`
(an empty original: no chunks, the empty digest). A 0.x file carrying
either is rejected. The Rust reader bounds a v1.x data line at 64 MiB.

## 4. Source references

Where an original came from is carried as `original_source` records
right after its last chunk, in strictly increasing `referenceId` order,
each bound to exactly that original (`evidenceId`, `assetId`, `sha256`,
`byteLength`), with an opaque `source` object (≤ 16 KiB, nesting ≤ 64 levels), `recordedAt`
and an optional `author`. They are append-only and immutable; an archive
carries every reference of every original it carries.

## 5. Trailer

Adds `originalChunks` and `originalSources`. Writers omit each when
zero, so a file without originals keeps the v0.7 trailer bytes. Readers
default them to zero.

## 5b. Cleaned-text derivatives

- `evidence.derivation` (`antares.normalized-text/v1`): a typed, immutable binding of blob-free
  cleaned-text Evidence to its primary's exact original. It names the normalizer, the job, a
  stable (possibly sparse) segment slot, a locator of at most 2 KiB, opaque coverage of at
  most 8 KiB nesting at most 64 levels, and the SHA-256 and length of its text.
- Placement: after the primary's chunks and source references, in strictly increasing
  `(jobId, index)`.
- Closure: a selected primary brings its visible derivatives, and a selected derivative brings
  its primary. There are no orphans.
- Counted as `evidence`. SPEC §5.6 is normative.
- The derivative record's size follows the ordinary Evidence row bounds. It is not a new
  document or segment ceiling.

## 6. Reading bounds

Any reader of this version bounds the memory it spends on the manifest
and, in a v1.x file, each data line (64 MiB). The Rust reader holds the
manifest to a budget (default 256 MiB, for every version, since the
manifest comes before the version): the line may not exceed it, and the
line plus a one-pass bound on its decoded size must fit it, both refused
by name before the parser allocates. A reader that can afford more
passes a larger budget. Every legacy golden opens at the default. This
bounds metadata, never an original.

## 7. Conformance

- New golden `originals.ant` (v1.0): one 150-byte original in three
  64-byte chunks with two source references, one empty original, one
  plain evidence. Runners reassemble each original, report its length
  and digest, and list the reference ids.
- New negatives, each valid in every other respect:
  `original_missing_chunk.ant`, `original_reordered.ant`,
  `original_chunk_digest.ant`, `original_whole_digest.ant`,
  `original_interrupted.ant`, `original_in_v0.ant`,
  `original_source_unbound.ant`.
- `major_version.ant` now declares **v2.0** (it declared v1.0, which is
  now a readable major).

## 8. Implementation checklist

- Accept majors 0 and 1; refuse others at the manifest.
- Add `original_chunk` to the known kinds and `originalChunks` to counts
  (zero default; omitted when zero on write).
- Enforce §3 while reading; reject a 0.x file with a `source_blob` or a
  chunk.
- Regenerate the JSON Schema and goldens from the Rust writer; update
  the Python and JavaScript bindings and run both conformance runners.

The OpenSPG-compatible `/public/v1` surface is unchanged.
