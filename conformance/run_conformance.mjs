#!/usr/bin/env node
// OpenAntares conformance suite — JS binding vs the golden files.
// Mirrors run_conformance.py (minus JSON-Schema validation, which the
// Python runner covers). Node >= 22 (native zstd).
//
//   node run_conformance.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const { AntError, AntReader, validate } = await import(
  join(HERE, "..", "bindings", "js", "openantares.mjs")
);

const GOLDEN = join(HERE, "golden");
const checks = [];

function check(name, ok, detail = "") {
  checks.push([name, ok]);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

function expectError(name, fn, needle) {
  try {
    fn();
  } catch (e) {
    if (e instanceof AntError) {
      check(name, e.message.includes(needle), `got: ${e.message}`);
      return;
    }
    check(name, false, `wrong error type: ${e}`);
    return;
  }
  check(name, false, "no error raised");
}

const expected = JSON.parse(readFileSync(join(GOLDEN, "expected.json"), "utf-8"));

console.log("== golden files ==");
for (const [fname, exp] of Object.entries(expected)) {
  const s = validate(join(GOLDEN, fname));
  check(`${fname}: verified`, s.verified);
  check(`${fname}: version`, s.manifest.version === exp.version);
  check(
    `${fname}: scope`,
    s.manifest.tenantId === exp.tenantId && s.manifest.projectId === exp.projectId,
  );
  const countsMatch =
    Object.keys(exp.counts).length === Object.keys(s.counts).length &&
    Object.entries(exp.counts).every(([k, v]) => s.counts[k] === v);
  check(`${fname}: counts`, countsMatch, JSON.stringify(s.counts));
  check(
    `${fname}: record kinds`,
    JSON.stringify(s.recordKinds) === JSON.stringify(exp.recordKinds),
    JSON.stringify(s.recordKinds),
  );
  if (exp.skippedKinds) {
    check(
      `${fname}: skipped kinds`,
      JSON.stringify(s.skippedKinds) === JSON.stringify(exp.skippedKinds),
      JSON.stringify(s.skippedKinds),
    );
  }
  // v0.5: same reasoning for `relationship_proposal`. Reporting the
  // statuses AND the measurement proves the binding read the record
  // rather than skipping it — and the measurement is the point: a
  // quarantined hypothesis at 0/1914 is what a grader had nothing to
  // read before this kind existed.
  if (exp.proposalStatuses) {
    const recs = [];
    const evidence = new Set();
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "relationship_proposal") recs.push(rec);
      if (rec.kind === "evidence") evidence.add(rec.data.id);
    }
    const got = recs.map((r) => r.data.status);
    check(
      `${fname}: proposal statuses`,
      JSON.stringify(got) === JSON.stringify(exp.proposalStatuses),
      JSON.stringify(got),
    );
    if (exp.proposalMatched) {
      const m = recs.map((r) => r.data.support.matchedRows);
      check(
        `${fname}: proposal matched rows`,
        JSON.stringify(m) === JSON.stringify(exp.proposalMatched),
        JSON.stringify(m),
      );
    }
    if (exp.proposalNonNull) {
      const d = recs.map((r) => r.data.support.sourceNonNull);
      check(
        `${fname}: proposal non-null denominators`,
        JSON.stringify(d) === JSON.stringify(exp.proposalNonNull),
        JSON.stringify(d),
      );
    }
    // A promotion carries its receipt, and the receipt is a record in
    // the same file: closure, from the binding's side.
    const promoted = recs.filter((r) => r.data.status === "promoted_by_reviewer");
    check(
      `${fname}: promotions carry a receipt present in the file`,
      promoted.every((p) => evidence.has(p.data.receipt.receipt)),
      JSON.stringify(promoted.map((p) => p.data.receipt.receipt)),
    );
    check(
      `${fname}: findings and probe results are present in the file`,
      recs.every(
        (r) =>
          (r.data.findings ?? []).every((f) => evidence.has(f)) &&
          (r.data.probes ?? [])
            .filter((pr) => pr.evidenceId != null)
            .every((pr) => evidence.has(pr.evidenceId)),
      ),
    );
  }
  // v0.4: a binding that skipped `contradiction_case` as unknown still
  // VERIFIES the file; reporting the states proves it read them.
  if (exp.epistemicStates || exp.workflowStates) {
    const recs = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "contradiction_case") recs.push(rec);
    }
    if (exp.epistemicStates) {
      const got = recs.map((r) => r.data.epistemic);
      check(`${fname}: epistemic states`, JSON.stringify(got) === JSON.stringify(exp.epistemicStates), JSON.stringify(got));
    }
    if (exp.workflowStates) {
      const got = recs.map((r) => r.data.workflow);
      check(`${fname}: workflow states`, JSON.stringify(got) === JSON.stringify(exp.workflowStates), JSON.stringify(got));
    }
  }
  // v0.6: explicitly-unknown observation time. A binding that could not
  // read the additive wire form would misclassify these — so the check
  // is on the DECODED state, not just the record count. `observedAt` /
  // `extractedAt` are one of three disjoint shapes: a bare RFC3339
  // string (Known, no basis), {known:{at,basis}}, or {unknown:{reason}}.
  if (exp.observedTimeStates || exp.extractedTimeBases || exp.unknownReasons) {
    const recs = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "observation") recs.push(rec);
    }
    const timeState = (v) => {
      if (typeof v === "string") return "known";
      if (v && typeof v === "object") {
        if ("known" in v) return "known";
        if ("unknown" in v) return "unknown";
      }
      return "?";
    };
    const timeBasis = (v) =>
      v && typeof v === "object" && "known" in v ? (v.known.basis ?? null) : null;
    if (exp.observedTimeStates) {
      const got = recs.map((r) => timeState(r.data.observed_at));
      check(`${fname}: observed time states`, JSON.stringify(got) === JSON.stringify(exp.observedTimeStates), JSON.stringify(got));
    }
    if (exp.extractedTimeBases) {
      const got = recs.map((r) => timeBasis(r.data.extracted_at));
      check(`${fname}: extracted time bases`, JSON.stringify(got) === JSON.stringify(exp.extractedTimeBases), JSON.stringify(got));
    }
    if (exp.unknownReasons) {
      const got = recs
        .filter((r) => r.data.observed_at && typeof r.data.observed_at === "object" && "unknown" in r.data.observed_at)
        .map((r) => r.data.observed_at.unknown.reason);
      check(`${fname}: unknown reasons`, JSON.stringify(got) === JSON.stringify(exp.unknownReasons), JSON.stringify(got));
    }
  }
}

console.log("== negatives (synthesized from basic.ant) ==");
const good = readFileSync(join(GOLDEN, "basic.ant"));
const lines = zstdDecompressSync(good).toString("utf-8").split("\n");
lines.pop();
const drain = (bytes) => {
  const r = new AntReader(bytes);
  for (const _ of r) {
    /* consume */
  }
};
const pack = (ls) => zstdCompressSync(Buffer.from(ls.join("\n") + "\n", "utf-8"));

const tampered = [...lines];
tampered[1] = tampered[1].replace("deal_1", "deal_X");
expectError("tampered record rejected", () => drain(pack(tampered)), "sha256 mismatch");

expectError("missing trailer rejected", () => drain(pack(lines.slice(0, -1))), "without a trailer");

expectError("chopped compressed bytes rejected", () => drain(good.subarray(0, good.length - 8)), "");

const withExtra = [...lines, '{"kind":"vertex","data":{"id":"late","label":"X"}}'];
expectError("data after trailer rejected", () => drain(pack(withExtra)), "after the trailer");

const body = lines.slice(0, -1);
const h = createHash("sha256");
for (const line of body) h.update(line + "\n", "utf-8");
const fakeTrailer = JSON.stringify({
  kind: "trailer",
  counts: {
    schemaTypes: 9, vertices: 0, edges: 0, observations: 0,
    evidence: 0, beliefs: 0, vectors: 0,
  },
  sha256: h.digest("hex"),
});
expectError("wrong counts rejected", () => drain(pack([...body, fakeTrailer])), "counts mismatch");

// A different MAJOR is rejected up front. A newer MINOR is not a
// negative any more — see the forward-compat section below.
const future = JSON.parse(lines[0]);
future.version = "9.9";
expectError(
  "different major version rejected",
  () => new AntReader(pack([JSON.stringify(future), ...lines.slice(1)])),
  "Major versions are not compatible",
);

// An unparsable version is an error, not a guess.
const badVersion = JSON.parse(lines[0]);
badVersion.version = "banana";
expectError(
  "malformed version rejected",
  () => new AntReader(pack([JSON.stringify(badVersion), ...lines.slice(1)])),
  "is not MAJOR.MINOR",
);

expectError(
  "non-zstd input rejected",
  () => new AntReader(Buffer.from("definitely not zstd")),
  "zstd",
);

console.log("== negative goldens (must be REJECTED) ==");
// Contract is "rejected", not a specific message: the error text
// differs per implementation, and pinning it would make the fixture
// untestable outside Rust.
const negatives = JSON.parse(readFileSync(join(GOLDEN, "expected_negatives.json"), "utf-8"));
for (const [fname, spec] of Object.entries(negatives)) {
  if (!spec.mustReject) throw new Error(`${fname}: only mustReject negatives are supported`);
  expectError(`${fname}: rejected`, () => validate(join(GOLDEN, fname)), "");
}

console.log("== forward compatibility: a newer MINOR is readable ==");
// The policy that makes an additive minor bump safe: same major reads
// at any minor, and the reader reports that it saw a subset.
//
// Rewriting the manifest changes the hashed bytes, so the trailer has
// to be recomputed — otherwise this would fail as a sha256 mismatch and
// prove nothing about versioning.
const ahead = JSON.parse(lines[0]);
ahead.version = "0.99";
const aheadBody = [JSON.stringify(ahead), ...lines.slice(1, -1)];
const h2 = createHash("sha256");
for (const line of aheadBody) h2.update(line + "\n", "utf-8");
const aheadTrailer = JSON.parse(lines[lines.length - 1]);
aheadTrailer.sha256 = h2.digest("hex");
const aheadReader = new AntReader(pack([...aheadBody, JSON.stringify(aheadTrailer)]));
const aheadKinds = [];
for (const rec of aheadReader) aheadKinds.push(rec.kind);
check(
  "newer minor still reads",
  aheadReader.verified && aheadKinds.length === 7,
  JSON.stringify(aheadKinds),
);
check("newer minor is flagged as ahead", aheadReader.minorAhead);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
