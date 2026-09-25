#!/usr/bin/env node
// OpenAntares conformance suite — JS binding vs the golden files.
// Mirrors run_conformance.py (minus JSON-Schema validation, which the
// Python runner covers). Node >= 22 (native zstd).
//
//   node run_conformance.mjs

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const { AntError, AntReader, JSON_SOURCE_TEXT, canonicalJsonSize, trailerCounts, validate } = await import(
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

const sortedKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// Integers past 2^53 (a u64 slot, a coverage fact) are read exactly, as
// the binding does.
const expected = JSON.parse(readFileSync(join(GOLDEN, "expected.json"), "utf-8"), (k, v, c) =>
  typeof v === "number" && !Number.isSafeInteger(v) && /^-?[0-9]+$/.test(c?.source ?? "")
    ? BigInt(c.source)
    : v,
);
const exact = (_k, v) => (typeof v === "bigint" ? `${v}n` : v);

// A derivative slot past 2^53 reads exactly only with JSON.parse source
// text (Node >= 21). Every supported runtime (Node >= 22) has it; a runtime
// without it must fail here by name, not by refusing a valid file.
check(
  `runtime: JSON.parse source-text access (Node ${process.versions.node})`,
  JSON_SOURCE_TEXT,
  "a full-range u64 derivative slot cannot be read exactly on this runtime",
);

console.log("== golden files ==");
for (const [fname, exp] of Object.entries(expected)) {
  const s = validate(join(GOLDEN, fname));
  check(`${fname}: verified`, s.verified);
  check(`${fname}: version`, s.manifest.version === exp.version);
  check(
    `${fname}: scope`,
    s.manifest.tenantId === exp.tenantId && s.manifest.projectId === exp.projectId,
  );
  const got = trailerCounts(s.counts);
  const countsMatch =
    Object.keys(exp.counts).length === Object.keys(got).length &&
    Object.entries(exp.counts).every(([k, v]) => got[k] === v);
  check(`${fname}: counts`, countsMatch, JSON.stringify(got));
  // v1.0: stored originals. Reassembling each one from its chunks and
  // reporting its length and digest proves the binding READ them (and
  // not merely skipped a kind while verifying the trailer).
  if (exp.originals) {
    const originals = [];
    let current = null;
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "evidence" && rec.data.source_blob) {
        current = { evidenceId: rec.data.id, byteLength: 0, sha: createHash("sha256"), chunks: 0 };
        originals.push(current);
      } else if (rec.kind === "original_chunk") {
        const raw = Buffer.from(rec.data.bytes, "base64");
        current.byteLength += raw.length;
        current.sha.update(raw);
        current.chunks += 1;
      }
    }
    const report = originals.map((o) => ({
      evidenceId: o.evidenceId,
      byteLength: o.byteLength,
      sha256: o.sha.digest("hex"),
      chunks: o.chunks,
    }));
    check(
      `${fname}: originals reassembled`,
      // expected.json is written with sorted keys; compare by value.
      JSON.stringify(report.map(sortedKeys)) === JSON.stringify(exp.originals.map(sortedKeys)),
      JSON.stringify(report),
    );
  }
  if (exp.sourceReferenceIds) {
    const got = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "original_source") got.push(rec.data.referenceId);
    }
    check(
      `${fname}: source references`,
      JSON.stringify(got) === JSON.stringify(exp.sourceReferenceIds),
      JSON.stringify(got),
    );
  }
  if (exp.derivatives) {
    // Cleaned-text derivatives the binding READ as such.
    const got = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      const d = rec.kind === "evidence" ? rec.data.derivation : undefined;
      if (d) {
        got.push({
          evidenceId: rec.data.id,
          primaryEvidenceId: d.primaryEvidenceId,
          jobId: d.jobId,
          index: d.segment.index,
        });
      }
    }
    check(
      `${fname}: derivatives`,
      JSON.stringify(got.map(sortedKeys), exact) ===
        JSON.stringify(exp.derivatives.map(sortedKeys), exact),
      JSON.stringify(got, exact),
    );
  }
  if (exp.sourceBytes || exp.source) {
    // A reference's source is opaque too: returned exactly, counted as the
    // Rust reader serializes it.
    const srcs = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "original_source") srcs.push(rec.data.source);
    }
    if (exp.sourceBytes) {
      const got = srcs.map((x) => canonicalJsonSize(x));
      check(
        `${fname}: source bytes as Rust counts them`,
        JSON.stringify(got) === JSON.stringify(exp.sourceBytes),
        JSON.stringify(got),
      );
    }
    if (exp.source) {
      check(
        `${fname}: source returned exactly`,
        JSON.stringify(sortedKeys(srcs[0]), exact) === JSON.stringify(sortedKeys(exp.source), exact),
        JSON.stringify(srcs[0], exact),
      );
    }
  }
  if (exp.coverageBytes || exp.coverage) {
    // Coverage is opaque and returned exactly; its size is counted as the
    // Rust reader serializes it (Rust wrote coverageBytes).
    const covs = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "evidence" && rec.data.derivation) covs.push(rec.data.derivation.segment.coverage);
    }
    if (exp.coverageBytes) {
      const got = covs.map((c) => canonicalJsonSize(c));
      check(
        `${fname}: coverage bytes as Rust counts them`,
        JSON.stringify(got) === JSON.stringify(exp.coverageBytes),
        JSON.stringify(got),
      );
    }
    if (exp.coverage) {
      check(
        `${fname}: coverage returned exactly`,
        JSON.stringify(sortedKeys(covs[0]), exact) === JSON.stringify(sortedKeys(exp.coverage), exact),
        JSON.stringify(covs[0], exact),
      );
    }
  }
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
  // v0.7: prove the binding surfaced the immutable ontology envelope,
  // not merely skipped a new kind while still verifying its bytes.
  if (exp.ontologyRevisionIds) {
    const recs = [];
    for (const rec of new AntReader(readFileSync(join(GOLDEN, fname)))) {
      if (rec.kind === "ontology_revision") recs.push(rec.data);
    }
    const fields = {
      ontologyRevisionIds: recs.map((r) => r.id),
      ontologyTargetVaults: recs.map((r) => r.manifest.target.vaultId),
      ontologyPreviousRevisionIds: recs.map((r) => r.conditional.previousRevisionId ?? null),
      ontologySemanticKinds: recs.map((r) => r.manifest.semanticItems.map((item) => item.kind)),
      ontologyConditionalDomains: recs.map((r) => r.conditional.revisionDomain),
      ontologyConditionalChains: recs.map((r) => r.conditional.chainId),
      ontologyPublisherPrincipals: recs.map((r) => r.publisher.principal),
      ontologyApprovalAttesters: recs.map(
        (r) => r.manifest.approval.attestation.attesterPrincipal,
      ),
      ontologyRetainedDispositions: recs.map(
        (r) => r.manifest.retainedPositions.map((position) => position.disposition),
      ),
      ontologyAttributionPrincipals: recs.map(
        (r) => r.manifest.attribution.map((item) => item.principal),
      ),
    };
    for (const [key, got] of Object.entries(fields)) {
      check(
        `${fname}: ${key}`,
        JSON.stringify(got) === JSON.stringify(exp[key]),
        JSON.stringify(got),
      );
    }
    const recordKey = (ref) => `${ref.kind}\0${ref.id}\0${ref.contentSha256}`;
    const closureOk = recs.every((revision) => {
      const manifest = revision.manifest;
      const published = new Set(manifest.publishedRecords.map(recordKey));
      const support = manifest.semanticItems.flatMap((item) => item.support)
        .concat(manifest.acceptedClaims ?? [])
        .concat((manifest.retainedPositions ?? []).flatMap((position) => position.records))
        .concat((manifest.attribution ?? []).map((item) => item.evidence));
      const publishedRevisions = new Set(
        (manifest.publishedRevisionRefs ?? []).map((ref) => ref.id),
      );
      const required = [];
      if (manifest.source.ontologyRevision) required.push(manifest.source.ontologyRevision.id);
      if (manifest.commonBase) required.push(manifest.commonBase.id);
      for (const dependency of manifest.dependencies ?? []) {
        if (dependency.ontologyRevision) required.push(dependency.ontologyRevision.id);
      }
      const targetHead = manifest.target.ontologyRevision?.id ?? null;
      return support.every((ref) => published.has(recordKey(ref)))
        && required.every((ref) => publishedRevisions.has(ref))
        && (revision.conditional.previousRevisionId ?? null) === targetHead;
    });
    check(`${fname}: ontology closure and predecessor`, closureOk);
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
  // `refusedFor` pins the reason where every reader states the rule in
  // the same words (the derivation rules).
  expectError(`${fname}: rejected`, () => validate(join(GOLDEN, fname)), spec.refusedFor ?? "");
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
