// OpenAntares `.ant` reference binding for JavaScript (Node >= 22,
// which ships native zstd in `node:zlib`). Reader + validator; spec:
// ../../SPEC.md, format versions 0.7 and 1.0 (1.0 carries stored
// originals, §5.6).
//
//   import { AntReader, validate, decodeProperty } from "./openantares.mjs";
//   const reader = new AntReader(fs.readFileSync("world.ant"));
//   for (const record of reader) { ... }        // {kind, data} objects
//   if (!reader.verified) throw new Error("unverified");
//
// CLI:  node openantares.mjs validate file.ant [file2.ant ...]
//
// Numbers: an integer the Rust reader holds exactly ([-2^63, 2^64-1]) is
// returned exactly — a `number` when safe, a `BigInt` past 2^53 (it was a
// silently rounded double before). `JSON.stringify` of a record holding a
// `BigInt` needs a replacer. Every other number is a `number` (a double, as
// in Rust).

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

// ---- generated from the Rust types by gen_schema: format facts ----
export const FORMAT_MAJOR = 0;
export const FORMAT_MINOR = 7;
export const FORMAT_VERSION = `${FORMAT_MAJOR}.${FORMAT_MINOR}`;
// Files that carry stored originals (SPEC §5.6).
export const ORIGINALS_FORMAT_MAJOR = 1;
export const ORIGINALS_FORMAT_MINOR = 0;
export const ORIGINALS_FORMAT_VERSION = `${ORIGINALS_FORMAT_MAJOR}.${ORIGINALS_FORMAT_MINOR}`;
// ---- end generated: format facts ----

// ---------------------------------------------------------------------
// Property values (v0.3)
// ---------------------------------------------------------------------

// v0.2 carried property values as bare JSON scalars. Those five shapes
// are UNCHANGED in v0.3, which adds a tagged envelope for the SQL types
// that are otherwise indistinguishable from strings — a DATE, a UUID
// and a TEXT are all JSON strings, so an untagged reader cannot tell
// them apart and the type is lost on the first round-trip.
const ENVELOPE_TAGS = new Set([
  "decimal", "date", "time", "timestamp", "uuid", "bytes", "int32", "int16", "array",
]);

/** True for a well-formed v0.3 tagged value.
 *
 * Deliberately strict: EXACTLY the two keys `$ant` and `v`, and a known
 * tag. A producer's own document that happens to carry a `$ant` field
 * is still that document and must round-trip as one.
 */
export function isPropertyEnvelope(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && "$ant" in v && "v" in v && ENVELOPE_TAGS.has(v.$ant);
}

/** Return `{type, value}` for a property value.
 *
 * `type` is a v0.3 tag, or `null` for a bare v0.2 scalar. Arrays are
 * decoded element-wise.
 *
 * The value is returned AS TEXT for decimal/date/time/timestamp/uuid,
 * and as base64 text for bytes. A decimal is NEVER converted to a JS
 * `number`: that is an IEEE double, so `Number("12345678901234567.89")`
 * silently becomes a different value. Use BigInt or a decimal library
 * if you need arithmetic.
 */
const U64_MAX = (1n << 64n) - 1n;

/** Whether this runtime passes JSON.parse revivers the source text (Node
 *  >= 21; every runtime this binding supports, Node >= 22). */
export const JSON_SOURCE_TEXT = (() => {
  let seen = false;
  JSON.parse("0", (_k, v, context) => {
    seen = typeof context?.source === "string";
    return v;
  });
  return seen;
})();

const I64_MIN = -(1n << 63n);
/** Canonical spellings of float literals, per holder object and key, as
 *  the Rust reader would serialize them (see `canonicalJsonSize`). */
const FLOAT_SPELLING = new WeakMap();

/** `JSON.parse` reviver. Every JSON number the Rust reader holds exactly —
 *  an integer literal in [-2^63, 2^64-1] — is returned exactly: a `number`
 *  when it is a safe integer, otherwise a `BigInt` read from its source
 *  text (a coverage fact, a u64 slot), never a rounded double. Numbers Rust
 *  holds as doubles (fractions, exponents, `-0`, integers outside that
 *  range) stay `number`, and their Rust spelling is recorded for the size
 *  accounting. Without source-text access (Node < 21) numbers are left as
 *  JSON.parse produced them. */
function numberReviver(key, value, context) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    // The Rust reader refuses a number no double can hold (serde_json:
    // "number out of range"); never let it become an infinity here.
    throw new AntError(`number out of range: ${context?.source ?? value}`);
  }
  const src = context?.source;
  if (typeof value !== "number" || typeof src !== "string" || this === null || typeof this !== "object") {
    return value;
  }
  if (/^-?[0-9]+$/.test(src) && src !== "-0") {
    const n = BigInt(src);
    if (n >= I64_MIN && n <= U64_MAX) return Number.isSafeInteger(value) ? value : n;
  }
  let spellings = FLOAT_SPELLING.get(this);
  if (spellings === undefined) FLOAT_SPELLING.set(this, (spellings = new Map()));
  spellings.set(key, floatText(value));
  return value;
}

/** A finite double exactly as the Rust reader serializes it (serde_json,
 *  whose float writer is `zmij`): shortest round-trip digits, in plain
 *  notation when the decimal exponent is -5..=15, otherwise as a mantissa
 *  and an exponent that always carries its sign (`1e+16`, `1e-7`). */
function floatText(x) {
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, exp] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "").replace(/0+$/, "");
  const n = digits.length;
  const kk = Number(exp) + 1;
  const k = kk - n;
  let out;
  if (k >= 0 && kk <= 16) out = digits + "0".repeat(kk - n) + ".0";
  else if (kk > 0 && kk <= 16) out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -5 && kk <= 0) out = `0.${"0".repeat(-kk)}${digits}`;
  else {
    const mantissa = n === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    out = `${mantissa}e${kk - 1 < 0 ? "-" : "+"}${Math.abs(kk - 1)}`;
  }
  return sign + out;
}

/** Bytes of `v` as the Rust reader serializes it compactly (serde_json):
 *  the accounting the 8 KiB coverage and 16 KiB source bounds use in every
 *  reader. Integers in [-2^63, 2^64-1] are written exactly; every other
 *  number as `floatText` of its double; strings JSON-escaped, UTF-8. */
export function canonicalJsonSize(v, holder = undefined, key = undefined) {
  if (v === null || v === true) return 4;
  if (v === false) return 5;
  if (typeof v === "bigint") return v.toString().length;
  if (typeof v === "number") {
    const spelled = holder === undefined ? undefined : FLOAT_SPELLING.get(holder)?.get(key);
    if (spelled !== undefined) return spelled.length;
    return (Number.isSafeInteger(v) && !Object.is(v, -0) ? String(v) : floatText(v)).length;
  }
  if (typeof v === "string") return utf8Len(JSON.stringify(v));
  if (Array.isArray(v)) {
    let size = 2 + Math.max(0, v.length - 1);
    v.forEach((x, i) => (size += canonicalJsonSize(x, v, String(i))));
    return size;
  }
  const keys = Object.keys(v);
  let size = 2 + Math.max(0, keys.length - 1);
  for (const k of keys) size += utf8Len(JSON.stringify(k)) + 1 + canonicalJsonSize(v[k], v, k);
  return size;
}

// Cleaned-text derivations (v1.0): the structural rules of the Rust
// `ant_types::Derivation::validate`, in its order and with its messages.
export const NORMALIZED_TEXT_CONTRACT = "antares.normalized-text/v1";
const DERIVATION_FIELDS = [
  "assetId", "byteLength", "contract", "jobId", "normalizer", "primaryEvidenceId",
  "segment", "sha256", "textByteLength", "textSha256",
];
const NORMALIZER_FIELDS = ["configurationSha256", "name", "version"];
const SEGMENT_FIELDS = ["coverage", "index", "locator"];
const DERIVATION_LOCATOR_MAX_BYTES = 2 * 1024;
const DERIVATION_COVERAGE_MAX_BYTES = 8 * 1024;
const DERIVATION_COVERAGE_MAX_DEPTH = 64;
/** Whether a JSON value nests deeper than `levels` arrays/objects, the value
 *  itself counting as one level when it is one. */
const nestsDeeper = (v, levels) =>
  v !== null &&
  typeof v === "object" &&
  (levels === 0 || (Array.isArray(v) ? v : Object.values(v)).some((c) => nestsDeeper(c, levels - 1)));
// Rust `char::is_control`: general category Cc.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const utf8Len = (s) => Buffer.byteLength(s, "utf8");
const isToken = (s, max) =>
  typeof s === "string" && utf8Len(s) >= 1 && utf8Len(s) <= max && /^[A-Za-z0-9_.:-]+$/.test(s);
const isHex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
// The literal `-0` is a double to the Rust reader, never a u64.
const isU64 = (n) =>
  (typeof n === "bigint" && n >= 0n && n <= U64_MAX) ||
  (Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0));
const sameKeys = (o, keys) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  JSON.stringify(Object.keys(o).sort()) === JSON.stringify(keys);

const SOURCE_REFERENCE_SOURCE_MAX_BYTES = 16 * 1024;
const SOURCE_REFERENCE_SOURCE_MAX_DEPTH = 64;
const isAssetId = (s) =>
  typeof s === "string" && utf8Len(s) >= 16 && utf8Len(s) <= 128 && /^[A-Za-z0-9_-]+$/.test(s);
const isPlainObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o);

/** The first structural problem of an Evidence `source_blob`, or null: the
 *  typed shape, then the Rust `SourceBlob::validate`, in its order and with
 *  its messages. */
function sourceBlobProblem(b) {
  if (
    !isPlainObject(b) ||
    !["assetId", "sha256", "mediaType", "fileName"].every((k) => typeof b[k] === "string") ||
    !isU64(b.byteLength)
  ) {
    return "malformed `evidence` record: sourceBlob has missing or invalid fields";
  }
  if (!isAssetId(b.assetId)) return "sourceBlob.assetId must be 16..=128 characters of [A-Za-z0-9_-]";
  if (!isHex64(b.sha256)) return "sourceBlob.sha256 must be 64 lowercase hex characters";
  const mt = Buffer.from(b.mediaType, "utf8");
  if (mt.length === 0 || mt.length > 255 || !mt.every((c) => c >= 0x20 && c < 0x7f)) {
    return "sourceBlob.mediaType must be 1..=255 printable ASCII bytes";
  }
  const fn = b.fileName;
  if (fn === "" || utf8Len(fn) > 1024 || CONTROL.test(fn)) {
    return "sourceBlob.fileName must be 1..=1024 bytes with no control characters";
  }
  return null;
}

/** The first structural problem of an `original_source` record, or null:
 *  the typed shape, then the Rust `SourceReference::validate`, in its order
 *  and with its messages. `recordedAt` need only be a string here: Rust's
 *  datetime parser stays the finer check, and a binding must not refuse a
 *  time Rust accepts. */
function sourceReferenceProblem(r) {
  if (
    !isPlainObject(r) ||
    !["evidenceId", "assetId", "sha256", "referenceId"].every((k) => typeof r[k] === "string") ||
    !isU64(r.byteLength) ||
    !("source" in r) ||
    typeof r.recordedAt !== "string" ||
    !(r.author === undefined || r.author === null || isPlainObject(r.author))
  ) {
    return "malformed `original_source` record: reference has missing or invalid fields";
  }
  if (!isToken(r.referenceId, 128)) {
    return "reference.referenceId must be 1..=128 characters of [A-Za-z0-9_.:-]";
  }
  if (!isPlainObject(r.source)) return "reference.source must be a JSON object";
  if (canonicalJsonSize(r.source) > SOURCE_REFERENCE_SOURCE_MAX_BYTES) {
    return `reference.source exceeds ${SOURCE_REFERENCE_SOURCE_MAX_BYTES} bytes serialized`;
  }
  if (nestsDeeper(r.source, SOURCE_REFERENCE_SOURCE_MAX_DEPTH)) {
    return `reference.source nests deeper than ${SOURCE_REFERENCE_SOURCE_MAX_DEPTH} levels`;
  }
  if (r.evidenceId === "" || CONTROL.test(r.evidenceId)) {
    return "reference.evidenceId must be non-empty with no control characters";
  }
  if (!isAssetId(r.assetId) || !isHex64(r.sha256)) return "reference.assetId/sha256 are malformed";
  return null;
}

/** The first structural problem of a derivation, or null: exactly the
 *  rules the Rust reader applies (the typed shape, then `validate`). The
 *  coverage bound uses `canonicalJsonSize`, the Rust reader's accounting. */
function derivationProblem(d) {
  if (!sameKeys(d, DERIVATION_FIELDS)) return "malformed `evidence` record: derivation has missing or unknown fields";
  const n = d.normalizer;
  const seg = d.segment;
  if (!sameKeys(n, NORMALIZER_FIELDS)) {
    return "malformed `evidence` record: derivation.normalizer has missing or unknown fields";
  }
  if (!sameKeys(seg, SEGMENT_FIELDS)) {
    return "malformed `evidence` record: derivation.segment has missing or unknown fields";
  }
  if (typeof seg.index === "number" && Number.isInteger(seg.index) && !Number.isSafeInteger(seg.index)) {
    // Only reachable without JSON.parse source-text access: say so rather
    // than call a valid file invalid.
    return (
      "derivation.segment.index is above 2^53 and this runtime cannot read it exactly " +
      "(JSON.parse source-text access, Node >= 21, is required)"
    );
  }
  if (!(isU64(d.byteLength) && isU64(d.textByteLength) && isU64(seg.index))) {
    return "malformed `evidence` record: derivation byteLength/textByteLength/segment.index must be u64 integers";
  }
  if (d.contract !== NORMALIZED_TEXT_CONTRACT) {
    return `derivation.contract must be \`${NORMALIZED_TEXT_CONTRACT}\``;
  }
  const pid = d.primaryEvidenceId;
  if (typeof pid !== "string" || pid === "" || CONTROL.test(pid)) {
    return "derivation.primaryEvidenceId must be non-empty with no control characters";
  }
  const aid = d.assetId;
  if (
    !(typeof aid === "string" && utf8Len(aid) >= 16 && utf8Len(aid) <= 128 && /^[A-Za-z0-9_-]+$/.test(aid)) ||
    !isHex64(d.sha256)
  ) {
    return "derivation.assetId/sha256 are malformed";
  }
  if (!isToken(n.name, 64) || !isToken(n.version, 64)) {
    return "derivation.normalizer.name/version must be 1..=64 characters of [A-Za-z0-9_.:-]";
  }
  if (!isHex64(n.configurationSha256)) {
    return "derivation.normalizer.configurationSha256 must be 64 lowercase hex characters";
  }
  if (!isToken(d.jobId, 128)) {
    return "derivation.jobId must be 1..=128 characters of [A-Za-z0-9_.:-]";
  }
  const loc = seg.locator;
  if (typeof loc !== "string" || loc === "" || utf8Len(loc) > DERIVATION_LOCATOR_MAX_BYTES || CONTROL.test(loc)) {
    return `derivation.segment.locator must be 1..=${DERIVATION_LOCATOR_MAX_BYTES} bytes with no control characters`;
  }
  const cov = seg.coverage;
  if (cov === null || typeof cov !== "object" || Array.isArray(cov)) {
    return "derivation.segment.coverage must be a JSON object";
  }
  if (canonicalJsonSize(cov) > DERIVATION_COVERAGE_MAX_BYTES) {
    return `derivation.segment.coverage exceeds ${DERIVATION_COVERAGE_MAX_BYTES} bytes serialized`;
  }
  if (nestsDeeper(cov, DERIVATION_COVERAGE_MAX_DEPTH)) {
    return `derivation.segment.coverage nests deeper than ${DERIVATION_COVERAGE_MAX_DEPTH} levels`;
  }
  if (!isHex64(d.textSha256)) return "derivation.textSha256 must be 64 lowercase hex characters";
  return null;
}

export function decodeProperty(v) {
  if (!isPropertyEnvelope(v)) return { type: null, value: v };
  if (v.$ant === "array") {
    return { type: "array", value: v.v.map(decodeProperty) };
  }
  return { type: v.$ant, value: v.v };
}

/** Build a v0.3 envelope. `type === null` emits the bare value. */
export function encodeProperty(type, value) {
  if (type === null) return value;
  if (!ENVELOPE_TAGS.has(type)) throw new AntError(`unknown property type \`${type}\``);
  return { $ant: type, v: value };
}

// ---- generated from the Rust types by gen_schema: kinds ----
const DATA_KINDS = new Set([
  "schema_type",
  "vertex",
  "edge",
  "observation",
  "evidence",
  "belief",
  "vector",
  "vertex_tombstone",
  "edge_tombstone",
  "contradiction_case",
  "relationship_proposal",
  "ontology_revision",
  "original_chunk",
  "original_source",
]);

const COUNT_KEYS = {
  schema_type: "schemaTypes",
  vertex: "vertices",
  edge: "edges",
  observation: "observations",
  evidence: "evidence",
  belief: "beliefs",
  vector: "vectors",
  vertex_tombstone: "vertexTombstones",
  edge_tombstone: "edgeTombstones",
  contradiction_case: "contradictionCases",
  relationship_proposal: "relationshipProposals",
  ontology_revision: "ontologyRevisions",
  original_chunk: "originalChunks",
  original_source: "originalSources",
};

// Trailer keys added after the first version. Absent in an older
// trailer, where they mean zero. Keys this binding does not know are
// ignored (spec §7/§8): they count kinds it skipped.
const LATER_COUNT_KEYS = [
  "vertexTombstones",
  "edgeTombstones",
  "contradictionCases",
  "relationshipProposals",
  "ontologyRevisions",
];

// Trailer keys a writer omits when zero, so a file that never uses
// the kind keeps its earlier trailer bytes.
const OMITTED_WHEN_ZERO = [
  "originalChunks",
  "originalSources",
];
// ---- end generated: kinds ----

export class AntError extends Error {}

/**
 * `MAJOR.MINOR` -> {major, minor}. A bare `MAJOR` means `MAJOR.0`.
 * Returns null when the value does not parse, which the caller must
 * treat as an error — guessing at a version is how a reader ends up
 * misinterpreting records.
 */
export function parseVersion(s) {
  if (typeof s !== "string") return null;
  const parts = s.split(".");
  if (parts.length === 1) parts.push("0");
  if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return { major: Number(parts[0]), minor: Number(parts[1]) };
}

// ---- generated from the Rust types by gen_schema: counts ----
function emptyCounts() {
  return {
    schemaTypes: 0,
    vertices: 0,
    edges: 0,
    observations: 0,
    evidence: 0,
    beliefs: 0,
    vectors: 0,
    vertexTombstones: 0,
    edgeTombstones: 0,
    contradictionCases: 0,
    relationshipProposals: 0,
    ontologyRevisions: 0,
    originalChunks: 0,
    originalSources: 0,
  };
}
// ---- end generated: counts ----

/** The counts as a trailer states them: keys a writer omits when zero
 *  (`OMITTED_WHEN_ZERO`) are left out, so a v0.7 file's counts compare
 *  equal to its trailer byte for byte. */
export function trailerCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts).filter(([k, v]) => v !== 0 || !OMITTED_WHEN_ZERO.includes(k)),
  );
}

function countsEqual(a, b) {
  // A v0.1 trailer omits the tombstone keys, and a writer omits the
  // originals keys when zero; both mean zero there, so default them
  // rather than failing a file for a field it predates or never used.
  return Object.keys(emptyCounts()).every((k) => {
    const defaulted = LATER_COUNT_KEYS.includes(k) || OMITTED_WHEN_ZERO.includes(k);
    const fromTrailer = a?.[k] ?? (defaulted ? 0 : -1);
    return fromTrailer === b[k];
  });
}

export class AntReader {
  /** @param {Buffer|Uint8Array} data compressed .ant bytes */
  constructor(data) {
    let raw;
    try {
      raw = zstdDecompressSync(data);
    } catch (e) {
      throw new AntError(`not an .ant stream: zstd: ${e.message}`);
    }
    if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) {
      throw new AntError("integrity: stream ended without a trailer (truncated?)");
    }
    const text = raw.toString("utf-8");
    this.lines = text.split("\n");
    this.lines.pop(); // trailing empty element after final \n
    if (this.lines.length === 0) throw new AntError("not an .ant stream: empty");

    const first = this.lines[0];
    let manifest;
    try {
      manifest = JSON.parse(first);
    } catch (e) {
      throw new AntError(`json on line 1: ${e.message}`);
    }
    if (manifest?.kind !== "manifest") {
      throw new AntError("not an .ant stream: first record is not a manifest");
    }
    if (manifest.format !== "antares") {
      throw new AntError(`not an .ant stream: format \`${manifest.format}\``);
    }
    // Version compatibility policy (spec §2): same major reads at ANY
    // minor, because minor bumps are additive-only by contract and
    // unknown kinds are skipped-but-hashed below. A different major is
    // refused — it means field meanings or the container framing
    // changed, so reading it here would silently misinterpret records
    // rather than fail.
    const parsed = parseVersion(manifest.version);
    if (parsed === null) {
      throw new AntError(
        `manifest version \`${manifest.version}\` is not MAJOR.MINOR; ` +
          `this reader implements ${FORMAT_VERSION}`,
      );
    }
    // This reader implements two majors: 0.x, and 1.x — files that carry
    // stored originals (§5.6). A 0.x-only reader refuses 1.x here, before
    // any record, which is why originals are a major.
    if (parsed.major !== FORMAT_MAJOR && parsed.major !== ORIGINALS_FORMAT_MAJOR) {
      throw new AntError(
        `file is format v${parsed.major}.${parsed.minor}, this reader implements ` +
          `v${FORMAT_VERSION} and v${ORIGINALS_FORMAT_VERSION}. Major versions are not ` +
          `compatible: a major bump means field meanings or the container framing ` +
          `changed, so reading it here would silently misinterpret records. Upgrade the ` +
          `reader to a v${parsed.major}.x build, or re-export the file at v${FORMAT_MAJOR}.`,
      );
    }
    /** File declares a newer minor than this reader implements: readable,
     *  but the caller got a SUBSET of what is in it. */
    const knownMinor =
      parsed.major === ORIGINALS_FORMAT_MAJOR ? ORIGINALS_FORMAT_MINOR : FORMAT_MINOR;
    this.minorAhead = parsed.minor > knownMinor;
    /** Whether this file may carry stored originals (1.x). */
    this.carriesOriginals = parsed.major >= ORIGINALS_FORMAT_MAJOR;
    /** The original whose chunks must come next, if any. */
    this.original = null;
    /** The original just completed, whose source references may follow. */
    this.completed = null;
    /** The primary whose cleaned-text derivatives are being read. */
    this.derivativesOf = null;
    this.manifest = manifest;
    this.counts = emptyCounts();
    this.skippedKinds = [];
    this.verified = false;
    this.hasher = createHash("sha256");
    this.hasher.update(first + "\n", "utf-8");
    this.pos = 1;
  }

  /** Next data record, or null after a VERIFIED trailer. Throws on any violation. */
  nextRecord() {
    for (;;) {
      if (this.pos >= this.lines.length) {
        throw new AntError("integrity: stream ended without a trailer (truncated?)");
      }
      const line = this.lines[this.pos++];
      const preTrailerDigest = this.hasher.copy().digest("hex");
      this.hasher.update(line + "\n", "utf-8");
      let rec;
      try {
        rec = JSON.parse(line, numberReviver);
      } catch (e) {
        throw new AntError(`json on line ${this.pos}: ${e.message}`);
      }
      if (typeof rec?.kind !== "string") {
        throw new AntError(`json on line ${this.pos}: record without string \`kind\``);
      }
      if (rec.kind === "manifest") {
        throw new AntError("not an .ant stream: duplicate manifest");
      }
      if (rec.kind === "trailer") {
        if (this.original !== null) {
          throw new AntError(
            `integrity: the original of evidence ${this.original.evidenceId} ends at byte ` +
              `${this.original.offset} of ${this.original.byteLength}: chunks missing`,
          );
        }
        if (rec.sha256 !== preTrailerDigest) {
          throw new AntError(
            `integrity: sha256 mismatch: trailer ${rec.sha256}, computed ${preTrailerDigest}`,
          );
        }
        if (!countsEqual(rec.counts, this.counts)) {
          throw new AntError(
            `integrity: counts mismatch: trailer ${JSON.stringify(rec.counts)}, ` +
              `read ${JSON.stringify(this.counts)}`,
          );
        }
        if (this.pos !== this.lines.length) {
          throw new AntError("integrity: data after the trailer");
        }
        this.verified = true;
        return null;
      }
      if (DATA_KINDS.has(rec.kind)) {
        this.counts[COUNT_KEYS[rec.kind]] += 1;
        this.checkOriginals(rec);
        return rec;
      }
      this.skippedKinds.push(rec.kind); // forward compat: skipped, still hashed
    }
  }

  /** Spec §5.6, as the Rust reader enforces it: an evidence with a
   *  `sourceBlob` is followed by exactly its chunks — contiguous, the right
   *  lengths, each and all matching their SHA-256 — and nothing else
   *  interrupts them. A 0.x file may carry neither. */
  /** A cleaned-text derivative (v1.0) follows its primary's original and
   *  source references, or another derivative of the same primary, in
   *  strictly increasing (jobId, index); binds exactly that original; and its
   *  content is exactly the text it names. */
  checkDerivative(data) {
    const d = data.derivation;
    const eid = data.id;
    if (!this.carriesOriginals) {
      throw new AntError(`integrity: evidence ${eid} is a derivative in a 0.x file`);
    }
    // `.ant` Evidence fields are snake_case: the original is `source_blob`.
    if (data.source_blob !== undefined && data.source_blob !== null) {
      throw new AntError(`integrity: evidence ${eid} carries both a derivation and an original`);
    }
    const problem = derivationProblem(d);
    if (problem !== null) throw new AntError(`integrity: ${problem}`);
    const raw = Buffer.from(data.content ?? "", "utf-8");
    if (createHash("sha256").update(raw).digest("hex") !== d.textSha256 || raw.length !== d.textByteLength) {
      throw new AntError(`integrity: derivative ${eid}: content is not the text its derivation names`);
    }
    const group = this.completed ?? this.derivativesOf;
    if (group === null) {
      throw new AntError(
        `integrity: derivative ${eid} does not follow its primary ${d.primaryEvidenceId}'s original`,
      );
    }
    if (
      d.primaryEvidenceId !== group.evidenceId ||
      d.assetId !== group.assetId ||
      d.sha256 !== group.sha256 ||
      d.byteLength !== group.byteLength
    ) {
      throw new AntError(
        `integrity: derivative ${eid} does not bind to the original of evidence ${group.evidenceId} it follows`,
      );
    }
    const job = d.jobId;
    const slot = d.segment?.index;
    // A slot is a full-range u64 (see `numberReviver`): compared as a
    // BigInt, never as a double.
    const index =
      typeof slot === "bigint" ? slot : Number.isSafeInteger(slot) ? BigInt(slot) : null;
    if (typeof job !== "string" || index === null || index < 0n || index > U64_MAX) {
      throw new AntError(`integrity: derivative ${eid}: jobId/segment.index invalid`);
    }
    const last = group === this.derivativesOf ? group.lastDerivative : null;
    if (last && (job < last[0] || (job === last[0] && index <= last[1]))) {
      throw new AntError(
        `integrity: derivative ${eid} of evidence ${group.evidenceId} is out of (jobId, index) order or repeated`,
      );
    }
    this.derivativesOf = {
      evidenceId: group.evidenceId,
      assetId: group.assetId,
      sha256: group.sha256,
      byteLength: group.byteLength,
      lastDerivative: [job, index],
    };
    this.completed = null;
  }

  checkOriginals(rec) {
    const data = rec.data ?? {};
    if (rec.kind === "original_chunk") {
      if (!this.carriesOriginals) {
        throw new AntError("integrity: original_chunk in a 0.x file; originals need v1.0");
      }
      const p = this.original;
      if (p === null) {
        throw new AntError(
          `integrity: original_chunk ${data.index} of evidence ${data.evidenceId} does ` +
            `not follow its evidence record`,
        );
      }
      if (data.evidenceId !== p.evidenceId || data.assetId !== p.assetId) {
        throw new AntError("integrity: original_chunk for a different evidence/asset");
      }
      if (data.index !== p.index || data.byteOffset !== p.offset) {
        throw new AntError(
          `integrity: original of evidence ${p.evidenceId}: chunk ${data.index} at ` +
            `${data.byteOffset} where chunk ${p.index} at ${p.offset} is next ` +
            `(missing or reordered chunk)`,
        );
      }
      const b64 = typeof data.bytes === "string" ? data.bytes : "";
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new AntError("integrity: original_chunk bytes are not base64");
      }
      const raw = Buffer.from(b64, "base64");
      const n = raw.length;
      if (n === 0 || createHash("sha256").update(raw).digest("hex") !== data.sha256) {
        throw new AntError(
          `integrity: original of evidence ${p.evidenceId}: chunk ${p.index} is empty ` +
            `or does not match its sha256`,
        );
      }
      const first = p.chunkLen ?? n;
      p.chunkLen = first;
      const end = p.offset + n;
      if (n > first || end > p.byteLength || (n < first && end !== p.byteLength)) {
        throw new AntError(
          `integrity: original of evidence ${p.evidenceId}: chunk ${p.index} has length ` +
            `${n}; chunks are ${first} bytes except a shorter last one`,
        );
      }
      p.hasher.update(raw);
      p.index += 1;
      p.offset = end;
      if (end === p.byteLength) {
        this.original = null;
        if (p.hasher.digest("hex") !== p.sha256) {
          throw new AntError(
            `integrity: original of evidence ${p.evidenceId} does not match its ` +
              `sourceBlob.sha256`,
          );
        }
        this.completed = {
          evidenceId: p.evidenceId,
          assetId: p.assetId,
          sha256: p.sha256,
          byteLength: p.byteLength,
          last: null,
        };
      }
      return;
    }
    if (rec.kind === "original_source") {
      if (!this.carriesOriginals) {
        throw new AntError("integrity: original_source in a 0.x file; originals need v1.0");
      }
      if (this.original !== null) {
        throw new AntError("integrity: an original_source interrupts an original's chunks");
      }
      const c = this.completed;
      if (c === null) {
        throw new AntError(
          `integrity: original_source ${data.referenceId} does not follow its original`,
        );
      }
      const problem = sourceReferenceProblem(data);
      if (problem !== null) throw new AntError(`integrity: ${problem}`);
      if (
        data.evidenceId !== c.evidenceId ||
        data.assetId !== c.assetId ||
        data.sha256 !== c.sha256 ||
        data.byteLength !== c.byteLength
      ) {
        throw new AntError(
          `integrity: original_source ${data.referenceId} does not bind to the original of ` +
            `evidence ${c.evidenceId}`,
        );
      }
      const rid = data.referenceId;
      if (c.last !== null && rid <= c.last) {
        throw new AntError(
          `integrity: original_source ${rid} of evidence ${c.evidenceId} is out of order or ` +
            `repeated`,
        );
      }
      c.last = rid;
      return;
    }
    if (this.original !== null) {
      throw new AntError(
        `integrity: the original of evidence ${this.original.evidenceId} ends at byte ` +
          `${this.original.offset} of ${this.original.byteLength}: chunks missing`,
      );
    }
    if (rec.kind === "evidence" && data.derivation !== undefined && data.derivation !== null) {
      this.checkDerivative(data);
      return;
    }
    this.completed = null;
    this.derivativesOf = null;
    const blob = rec.kind === "evidence" ? data.source_blob : undefined;
    if (blob === undefined || blob === null) return;
    if (!this.carriesOriginals) {
      throw new AntError(
        `integrity: evidence ${data.id} has a sourceBlob in a 0.x file; originals need v1.0`,
      );
    }
    const blobProblem = sourceBlobProblem(blob);
    if (blobProblem !== null) throw new AntError(`integrity: ${blobProblem}`);
    if (blob.byteLength === 0) {
      if (blob.sha256 !== createHash("sha256").update(Buffer.alloc(0)).digest("hex")) {
        throw new AntError(
          `integrity: evidence ${data.id} declares an empty original with the wrong sha256`,
        );
      }
      this.completed = {
        evidenceId: data.id,
        assetId: blob.assetId,
        sha256: blob.sha256,
        byteLength: 0,
        last: null,
      };
      return;
    }
    this.original = {
      evidenceId: data.id,
      assetId: blob.assetId,
      byteLength: blob.byteLength,
      sha256: blob.sha256,
      index: 0,
      offset: 0,
      chunkLen: null,
      hasher: createHash("sha256"),
    };
  }

  [Symbol.iterator]() {
    return {
      next: () => {
        const rec = this.nextRecord();
        return rec === null ? { done: true, value: undefined } : { done: false, value: rec };
      },
    };
  }
}

/** Read + fully verify one file. Throws AntError; returns a summary. */
export function validate(path) {
  const reader = new AntReader(readFileSync(path));
  const recordKinds = [];
  for (const rec of reader) recordKinds.push(rec.kind);
  return {
    manifest: reader.manifest,
    counts: reader.counts,
    recordKinds,
    skippedKinds: reader.skippedKinds,
    verified: reader.verified,
    minorAhead: reader.minorAhead,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...files] = process.argv.slice(2);
  if (cmd !== "validate" || files.length === 0) {
    console.error("usage: node openantares.mjs validate <file.ant> [...]");
    process.exit(64);
  }
  let rc = 0;
  for (const f of files) {
    try {
      const s = validate(f);
      console.log(
        `${f}: OK  version=${s.manifest.version} records=${s.recordKinds.length} ` +
          `skipped=${s.skippedKinds.length} counts=${JSON.stringify(s.counts)}`,
      );
    } catch (e) {
      console.error(`${f}: FAIL  ${e.message}`);
      rc = 65;
    }
  }
  process.exit(rc);
}
