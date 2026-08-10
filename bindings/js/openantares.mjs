// OpenAntares `.ant` reference binding for JavaScript (Node >= 22.15,
// which ships native zstd in `node:zlib`). Reader + validator; spec:
// ../../SPEC.md, format version 0.1.
//
//   import { AntReader, validate } from "./openantares.mjs";
//   const reader = new AntReader(fs.readFileSync("world.ant"));
//   for (const record of reader) { ... }        // {kind, data} objects
//   if (!reader.verified) throw new Error("unverified");
//
// CLI:  node openantares.mjs validate file.ant [file2.ant ...]

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

export const FORMAT_VERSION = "0.1";

const DATA_KINDS = new Set([
  "schema_type",
  "vertex",
  "edge",
  "observation",
  "evidence",
  "belief",
  "vector",
]);

const COUNT_KEYS = {
  schema_type: "schemaTypes",
  vertex: "vertices",
  edge: "edges",
  observation: "observations",
  evidence: "evidence",
  belief: "beliefs",
  vector: "vectors",
};

export class AntError extends Error {}

function emptyCounts() {
  return {
    schemaTypes: 0,
    vertices: 0,
    edges: 0,
    observations: 0,
    evidence: 0,
    beliefs: 0,
    vectors: 0,
  };
}

function countsEqual(a, b) {
  return Object.keys(emptyCounts()).every((k) => (a?.[k] ?? -1) === b[k]);
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
    if (manifest.version !== FORMAT_VERSION) {
      throw new AntError(
        `unsupported format version ${manifest.version} (reader supports ${FORMAT_VERSION})`,
      );
    }
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
