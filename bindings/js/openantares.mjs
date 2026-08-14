// OpenAntares `.ant` reference binding for JavaScript (Node >= 22,
// which ships native zstd in `node:zlib`). Reader + validator; spec:
// ../../SPEC.md, format version 0.3.
//
//   import { AntReader, validate, decodeProperty } from "./openantares.mjs";
//   const reader = new AntReader(fs.readFileSync("world.ant"));
//   for (const record of reader) { ... }        // {kind, data} objects
//   if (!reader.verified) throw new Error("unverified");
//
// CLI:  node openantares.mjs validate file.ant [file2.ant ...]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

export const FORMAT_MAJOR = 0;
export const FORMAT_MINOR = 3;
export const FORMAT_VERSION = `${FORMAT_MAJOR}.${FORMAT_MINOR}`;

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

const DATA_KINDS = new Set([
  "schema_type",
  "vertex",
  "edge",
  "observation",
  "evidence",
  "belief",
  "vector",
  // v0.2
  "vertex_tombstone",
  "edge_tombstone",
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
};

// v0.2 trailer keys. Absent in a v0.1 trailer, where they mean zero.
const V02_COUNT_KEYS = ["vertexTombstones", "edgeTombstones"];

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
  };
}

function countsEqual(a, b) {
  // A v0.1 trailer omits the tombstone keys; they mean zero there, so
  // default them rather than failing an older file for a field it
  // predates.
  return Object.keys(emptyCounts()).every((k) => {
    const fromTrailer = a?.[k] ?? (V02_COUNT_KEYS.includes(k) ? 0 : -1);
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
    if (parsed.major !== FORMAT_MAJOR) {
      throw new AntError(
        `file is format v${parsed.major}.${parsed.minor}, this reader implements ` +
          `v${FORMAT_VERSION}. Major versions are not compatible: a major bump means ` +
          `field meanings or the container framing changed, so reading it here would ` +
          `silently misinterpret records. Upgrade the reader to a v${parsed.major}.x ` +
          `build, or re-export the file at v${FORMAT_MAJOR}.`,
      );
    }
    /** File declares a newer minor than this reader implements: readable,
     *  but the caller got a SUBSET of what is in it. */
    this.minorAhead = parsed.minor > FORMAT_MINOR;
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
        rec = JSON.parse(line);
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
        return rec;
      }
      this.skippedKinds.push(rec.kind); // forward compat: skipped, still hashed
    }
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
