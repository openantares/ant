#!/usr/bin/env python3
"""OpenAntares conformance suite — Python binding vs the golden files.

Golden files are produced by the canonical Rust writer
(`cargo run -p antares-format --example gen_conformance`); this runner
proves the Python reference binding reads them byte-identically to the
spec, that every line validates against schema/ant.schema.json
(`jsonschema` is REQUIRED — a missing module is a failed check, not a
skipped one), that negatives (tamper, truncation, post-trailer data,
bad version) are rejected, and that the Python WRITER produces files
the reader verifies (self round-trip).

    pip install zstandard jsonschema
    python3 run_conformance.py
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import zstandard

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bindings" / "python"))
from openantares import AntError, AntReader, AntWriter, canonical_json_size, validate  # noqa: E402

GOLDEN = HERE / "golden"
CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def expect_error(name: str, fn, needle: str) -> None:
    try:
        fn()
    except AntError as e:
        check(name, needle in str(e), f"got: {e}")
        return
    except Exception as e:  # a reader refuses with AntError; anything else is a crash
        check(name, False, f"wrong error type: {type(e).__name__}: {e}")
        return
    check(name, False, "no error raised")


def decompress(data: bytes) -> bytes:
    return zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)).read()


def recompress(raw: bytes) -> bytes:
    return zstandard.ZstdCompressor().compress(raw)


def main() -> int:
    expected = json.loads((GOLDEN / "expected.json").read_text())

    print("== golden files ==")
    for fname, exp in expected.items():
        path = GOLDEN / fname
        s = validate(str(path))
        check(f"{fname}: verified", s.verified)
        check(f"{fname}: version", s.manifest["version"] == exp["version"])
        check(
            f"{fname}: scope",
            s.manifest["tenantId"] == exp["tenantId"]
            and s.manifest["projectId"] == exp["projectId"],
        )
        check(f"{fname}: counts", s.counts.as_trailer_dict() == exp["counts"],
              f"got {s.counts.as_trailer_dict()}")
        # v1.0: stored originals. Reassembling each one from its chunks and
        # reporting its length and digest proves the binding READ them (and
        # not merely skipped a kind while verifying the trailer).
        if "originals" in exp:
            import base64
            import hashlib

            originals = []
            for r in AntReader(path.read_bytes()):
                if r["kind"] == "evidence" and r["data"].get("source_blob"):
                    originals.append({"evidenceId": r["data"]["id"], "raw": hashlib.sha256(),
                                      "byteLength": 0, "chunks": 0})
                elif r["kind"] == "original_chunk":
                    raw = base64.b64decode(r["data"]["bytes"])
                    originals[-1]["raw"].update(raw)
                    originals[-1]["byteLength"] += len(raw)
                    originals[-1]["chunks"] += 1
            got = [{"evidenceId": o["evidenceId"], "byteLength": o["byteLength"],
                    "sha256": o["raw"].hexdigest(), "chunks": o["chunks"]} for o in originals]
            check(f"{fname}: originals reassembled", got == exp["originals"], f"got {got}")
        if "sourceReferenceIds" in exp:
            got = [r["data"]["referenceId"] for r in AntReader(path.read_bytes())
                   if r["kind"] == "original_source"]
            check(f"{fname}: source references", got == exp["sourceReferenceIds"], f"got {got}")
        if "derivatives" in exp:
            # Cleaned-text derivatives the binding READ as such (typed
            # derivation kept, not flattened to plain evidence).
            got = [{"evidenceId": r["data"]["id"],
                    "primaryEvidenceId": r["data"]["derivation"]["primaryEvidenceId"],
                    "jobId": r["data"]["derivation"]["jobId"],
                    "index": r["data"]["derivation"]["segment"]["index"]}
                   for r in AntReader(path.read_bytes())
                   if r["kind"] == "evidence" and r["data"].get("derivation") is not None]
            check(f"{fname}: derivatives", got == exp["derivatives"], f"got {got}")
        if "sourceBytes" in exp or "source" in exp:
            # A reference's source is opaque too: returned exactly, counted
            # as the Rust reader serializes it.
            srcs = [r["data"]["source"] for r in AntReader(path.read_bytes())
                    if r["kind"] == "original_source"]
            if "sourceBytes" in exp:
                got = [canonical_json_size(x) for x in srcs]
                check(f"{fname}: source bytes as Rust counts them",
                      got == exp["sourceBytes"], f"got {got}")
            if "source" in exp:
                check(f"{fname}: source returned exactly", srcs[0] == exp["source"],
                      f"got {srcs[0]}")
        if "coverageBytes" in exp or "coverage" in exp:
            # Coverage is opaque and returned exactly; its size is counted
            # as the Rust reader serializes it (Rust wrote coverageBytes).
            covs = [r["data"]["derivation"]["segment"]["coverage"]
                    for r in AntReader(path.read_bytes())
                    if r["kind"] == "evidence" and r["data"].get("derivation") is not None]
            if "coverageBytes" in exp:
                got = [canonical_json_size(c) for c in covs]
                check(f"{fname}: coverage bytes as Rust counts them",
                      got == exp["coverageBytes"], f"got {got}")
            if "coverage" in exp:
                check(f"{fname}: coverage returned exactly", covs[0] == exp["coverage"],
                      f"got {covs[0]}")
        check(f"{fname}: record kinds", s.record_kinds == exp["recordKinds"],
              f"got {s.record_kinds}")
        if "skippedKinds" in exp:
            check(f"{fname}: skipped kinds", s.skipped_kinds == exp["skippedKinds"],
                  f"got {s.skipped_kinds}")
        # v0.5: same reasoning for `relationship_proposal`. Reporting
        # the statuses AND the measurement proves the binding read the
        # record rather than skipping it — and the measurement is the
        # point: a quarantined hypothesis at 0/1914 is what a grader
        # had nothing to read before this kind existed.
        if "proposalStatuses" in exp:
            recs = [
                r for r in AntReader(path.read_bytes())
                if r["kind"] == "relationship_proposal"
            ]
            got = [r["data"]["status"] for r in recs]
            check(f"{fname}: proposal statuses", got == exp["proposalStatuses"], f"got {got}")
            if "proposalMatched" in exp:
                got = [r["data"]["support"]["matchedRows"] for r in recs]
                check(f"{fname}: proposal matched rows", got == exp["proposalMatched"],
                      f"got {got}")
            if "proposalNonNull" in exp:
                got = [r["data"]["support"]["sourceNonNull"] for r in recs]
                check(f"{fname}: proposal non-null denominators",
                      got == exp["proposalNonNull"], f"got {got}")
            # A promotion carries its receipt, and the receipt is a
            # record in the same file: closure, from the binding's side.
            ev = {
                r["data"]["id"] for r in AntReader(path.read_bytes())
                if r["kind"] == "evidence"
            }
            promoted = [r for r in recs if r["data"]["status"] == "promoted_by_reviewer"]
            check(f"{fname}: promotions carry a receipt present in the file",
                  all(p["data"]["receipt"]["receipt"] in ev for p in promoted),
                  f"receipts {[p['data']['receipt']['receipt'] for p in promoted]} vs {sorted(ev)}")
            check(f"{fname}: findings and probe results are present in the file",
                  all(f in ev for r in recs for f in r["data"].get("findings", []))
                  and all(
                      pr.get("evidenceId") in ev
                      for r in recs for pr in r["data"].get("probes", [])
                      if pr.get("evidenceId") is not None
                  ))

        # v0.7: prove the binding surfaced the immutable ontology envelope,
        # not merely skipped a new kind while still verifying its bytes.
        if "ontologyRevisionIds" in exp:
            recs = [
                r["data"] for r in AntReader(path.read_bytes())
                if r["kind"] == "ontology_revision"
            ]
            fields = {
                "ontologyRevisionIds": [r["id"] for r in recs],
                "ontologyTargetVaults": [r["manifest"]["target"]["vaultId"] for r in recs],
                "ontologyPreviousRevisionIds": [
                    r["conditional"].get("previousRevisionId") for r in recs
                ],
                "ontologySemanticKinds": [
                    [item["kind"] for item in r["manifest"]["semanticItems"]]
                    for r in recs
                ],
                "ontologyConditionalDomains": [
                    r["conditional"]["revisionDomain"] for r in recs
                ],
                "ontologyConditionalChains": [r["conditional"]["chainId"] for r in recs],
                "ontologyPublisherPrincipals": [r["publisher"]["principal"] for r in recs],
                "ontologyApprovalAttesters": [
                    r["manifest"]["approval"]["attestation"]["attesterPrincipal"]
                    for r in recs
                ],
                "ontologyRetainedDispositions": [
                    [position["disposition"] for position in r["manifest"]["retainedPositions"]]
                    for r in recs
                ],
                "ontologyAttributionPrincipals": [
                    [item["principal"] for item in r["manifest"]["attribution"]]
                    for r in recs
                ],
            }
            for key, got in fields.items():
                check(f"{fname}: {key}", got == exp[key], f"got {got}")

            def _record_key(ref):
                return (ref["kind"], ref["id"], ref["contentSha256"])

            closure_ok = True
            for revision in recs:
                manifest = revision["manifest"]
                published = {_record_key(ref) for ref in manifest["publishedRecords"]}
                support = [
                    ref for item in manifest["semanticItems"] for ref in item["support"]
                ]
                support += manifest.get("acceptedClaims", [])
                support += [
                    ref
                    for position in manifest.get("retainedPositions", [])
                    for ref in position["records"]
                ]
                support += [a["evidence"] for a in manifest.get("attribution", [])]
                closure_ok &= all(_record_key(ref) in published for ref in support)
                published_revisions = {
                    ref["id"] for ref in manifest.get("publishedRevisionRefs", [])
                }
                required = []
                if manifest["source"].get("ontologyRevision"):
                    required.append(manifest["source"]["ontologyRevision"]["id"])
                if manifest.get("commonBase"):
                    required.append(manifest["commonBase"]["id"])
                required += [
                    pin["ontologyRevision"]["id"]
                    for pin in manifest.get("dependencies", [])
                    if pin.get("ontologyRevision")
                ]
                closure_ok &= all(ref in published_revisions for ref in required)
                target_head = manifest["target"].get("ontologyRevision")
                closure_ok &= revision["conditional"].get("previousRevisionId") == (
                    target_head["id"] if target_head else None
                )
            check(f"{fname}: ontology closure and predecessor", closure_ok)

        # v0.4: a binding that skipped `contradiction_case` as unknown
        # still VERIFIES the file; reporting the states proves it read them.
        if "epistemicStates" in exp or "workflowStates" in exp:
            recs = [r for r in AntReader(path.read_bytes()) if r["kind"] == "contradiction_case"]
            if "epistemicStates" in exp:
                got = [r["data"]["epistemic"] for r in recs]
                check(f"{fname}: epistemic states", got == exp["epistemicStates"], f"got {got}")
            if "workflowStates" in exp:
                got = [r["data"]["workflow"] for r in recs]
                check(f"{fname}: workflow states", got == exp["workflowStates"], f"got {got}")

        # v0.6: explicitly-unknown observation time. A binding that could
        # not read the additive wire form would misclassify these — so
        # the check is on the DECODED state, not just the record count.
        # `observed_at`/`extracted_at` are one of three disjoint shapes:
        # a bare RFC3339 string (Known, no basis), {"known":{at,basis}},
        # or {"unknown":{reason}}.
        def _time_state(v):
            if isinstance(v, str):
                return "known"
            if isinstance(v, dict):
                if "known" in v:
                    return "known"
                if "unknown" in v:
                    return "unknown"
            return "?"

        def _time_basis(v):
            if isinstance(v, dict) and "known" in v:
                return v["known"].get("basis")
            return None  # bare string is Known with no basis

        if "observedTimeStates" in exp:
            recs = [r for r in AntReader(path.read_bytes()) if r["kind"] == "observation"]
            got = [_time_state(r["data"]["observed_at"]) for r in recs]
            check(f"{fname}: observed time states", got == exp["observedTimeStates"],
                  f"got {got}")
        if "extractedTimeBases" in exp:
            recs = [r for r in AntReader(path.read_bytes()) if r["kind"] == "observation"]
            got = [_time_basis(r["data"]["extracted_at"]) for r in recs]
            check(f"{fname}: extracted time bases", got == exp["extractedTimeBases"],
                  f"got {got}")
        if "unknownReasons" in exp:
            recs = [r for r in AntReader(path.read_bytes()) if r["kind"] == "observation"]
            got = [r["data"]["observed_at"]["unknown"]["reason"]
                   for r in recs
                   if isinstance(r["data"]["observed_at"], dict)
                   and "unknown" in r["data"]["observed_at"]]
            check(f"{fname}: unknown reasons", got == exp["unknownReasons"], f"got {got}")

    print("== schema validation (every golden line) ==")
    try:
        import jsonschema
    except ImportError:
        # A skipped check reads as a pass in a log nobody scrolls. This
        # check was silently skipped everywhere `jsonschema` was absent
        # — CI included — until it became a failure.
        check("jsonschema importable (pip install jsonschema)", False,
              "schema validation cannot run without it")
    else:
        schema = json.loads((HERE.parent / "schema" / "ant.schema.json").read_text())
        v = jsonschema.Draft202012Validator(schema)
        for fname in expected:
            raw = decompress((GOLDEN / fname).read_bytes())
            bad = 0
            for i, line in enumerate(raw.decode().splitlines(), 1):
                errs = list(v.iter_errors(json.loads(line)))
                if errs:
                    bad += 1
                    print(f"    {fname}:{i}: {errs[0].message}")
            check(f"{fname}: all lines match ant.schema.json", bad == 0)

        # The schema's conditionals have teeth, or they are decoration.
        # Each shape below is well-formed JSON of the right kinds and
        # types; only the rule it breaks tells it apart. The generated
        # schema derives these rules from the writer's types (the status
        # variants; `SamplingMethod::field_rule`), so this is where a
        # regeneration that dropped one would show.
        print("== schema conditionals (malformed shapes must be rejected) ==")
        import copy
        raw = decompress((GOLDEN / "relationship_proposals.ant").read_bytes())
        proposal = next(
            json.loads(l) for l in raw.decode().splitlines() if l.strip()
            and json.loads(l)["kind"] == "relationship_proposal"
        )

        def with_sampling(**sampling):
            r = copy.deepcopy(proposal)
            r["data"]["support"]["sampling"] = sampling
            return r

        def with_status(status, **fields):
            r = copy.deepcopy(proposal)
            for k in ("reason", "receipt"):
                r["data"].pop(k, None)
            r["data"]["status"] = status
            r["data"].update(fields)
            return r

        receipt = {"reviewer": "user:alice", "reason": "seen the data",
                   "receipt": "ev_receipt_1", "decidedAt": "2026-08-10T00:00:00Z"}
        rejected = [
            ("full_scan with percent", with_sampling(method="full_scan", percent=10.0)),
            ("full_scan with seed", with_sampling(method="full_scan", seed=7)),
            ("full_scan with cap", with_sampling(method="full_scan", cap=100)),
            ("system_repeatable without seed", with_sampling(method="system_repeatable", percent=10.0)),
            ("bernoulli_repeatable without percent", with_sampling(method="bernoulli_repeatable", seed=7)),
            ("capped_prefix without cap", with_sampling(method="capped_prefix")),
            ("promoted_by_reviewer without receipt", with_status("promoted_by_reviewer")),
            ("quarantined_hypothesis without reason", with_status("quarantined_hypothesis")),
        ]
        accepted = [
            ("system_repeatable with percent and seed", with_sampling(method="system_repeatable", percent=10.0, seed=7)),
            ("capped_prefix with cap", with_sampling(method="capped_prefix", cap=100)),
            ("promoted_by_reviewer with receipt", with_status("promoted_by_reviewer", receipt=receipt)),
            ("refuted with reason", with_status("refuted", reason="the join did not hold")),
        ]
        for name, line in rejected:
            check(f"rejects {name}", not v.is_valid(line))
        for name, line in accepted:
            check(f"accepts {name}", v.is_valid(line))

    print("== negatives (synthesized from basic.ant) ==")
    good = (GOLDEN / "basic.ant").read_bytes()
    raw = decompress(good)
    lines = raw.decode().split("\n")[:-1]

    # tamper with a data record, keep the stale trailer -> sha mismatch
    tampered = lines.copy()
    tampered[1] = tampered[1].replace("deal_1", "deal_X", 1)
    expect_error(
        "tampered record rejected",
        lambda: list(AntReader(recompress(("\n".join(tampered) + "\n").encode()))),
        "sha256 mismatch",
    )

    # drop the trailer entirely -> truncation
    truncated = lines[:-1]
    expect_error(
        "missing trailer rejected",
        lambda: list(AntReader(recompress(("\n".join(truncated) + "\n").encode()))),
        "without a trailer",
    )

    # bytes chopped mid-frame -> zstd/harder failure, never success
    expect_error(
        "chopped compressed bytes rejected",
        lambda: list(AntReader(good[: len(good) - 8])),
        "",  # message differs by layer; any AntError is a pass
    )

    # data after the trailer -> rejected
    with_extra = lines + ['{"kind":"vertex","data":{"id":"late","label":"X"}}']
    expect_error(
        "data after trailer rejected",
        lambda: list(AntReader(recompress(("\n".join(with_extra) + "\n").encode()))),
        "after the trailer",
    )

    # wrong counts, correct hash -> counts mismatch
    import hashlib
    body = lines[:-1]
    h = hashlib.sha256()
    for line in body:
        h.update(line.encode() + b"\n")
    fake_trailer = json.dumps(
        {"kind": "trailer",
         "counts": {"schemaTypes": 9, "vertices": 0, "edges": 0, "observations": 0,
                    "evidence": 0, "beliefs": 0, "vectors": 0},
         "sha256": h.hexdigest()},
        separators=(",", ":"),
    )
    expect_error(
        "wrong counts rejected",
        lambda: list(AntReader(recompress(("\n".join(body + [fake_trailer]) + "\n").encode()))),
        "counts mismatch",
    )

    # A different MAJOR is rejected up front. A newer MINOR is not a
    # negative any more — see the forward-compat section below.
    future = json.loads(lines[0])
    future["version"] = "9.9"
    expect_error(
        "different major version rejected",
        lambda: AntReader(recompress(("\n".join([json.dumps(future, separators=(',', ':'))]
                                                + lines[1:]) + "\n").encode())),
        "Major versions are not compatible",
    )

    # An unparsable version is an error, not a guess.
    bad = json.loads(lines[0])
    bad["version"] = "banana"
    expect_error(
        "malformed version rejected",
        lambda: AntReader(recompress(("\n".join([json.dumps(bad, separators=(',', ':'))]
                                                + lines[1:]) + "\n").encode())),
        "is not MAJOR.MINOR",
    )

    # not zstd at all
    expect_error("non-zstd input rejected", lambda: AntReader(b"definitely not zstd"), "zstd")

    print("== negative goldens (must be REJECTED) ==")
    negatives_path = GOLDEN / "expected_negatives.json"
    if not negatives_path.exists():
        check("expected_negatives.json present", False, "missing — regenerate goldens")
    else:
        for fname, spec in json.loads(negatives_path.read_text()).items():
            assert spec.get("mustReject"), f"{fname}: only mustReject negatives are supported"
            # Contract is "rejected", not a specific message: the error
            # text differs per implementation. Where every reader states a
            # rule in the same words (the derivation rules), `refusedFor`
            # pins the reason, so a file refused for another rule fails.
            expect_error(f"{fname}: rejected", lambda p=GOLDEN / fname: validate(str(p)),
                         spec.get("refusedFor", ""))

    print("== forward compatibility: a newer MINOR is readable ==")
    # The policy that makes an additive minor bump safe: same major
    # reads at any minor, and the reader reports that it saw a subset.
    #
    # Rewriting the manifest changes the hashed bytes, so the trailer
    # has to be recomputed — otherwise this would fail as a sha256
    # mismatch and prove nothing about versioning.
    ahead = json.loads(lines[0])
    ahead["version"] = "0.99"
    body = [json.dumps(ahead, separators=(",", ":"))] + lines[1:-1]
    h2 = hashlib.sha256()
    for line in body:
        h2.update(line.encode() + b"\n")
    trailer = json.loads(lines[-1])
    trailer["sha256"] = h2.hexdigest()
    stream = body + [json.dumps(trailer, separators=(",", ":"))]
    r = AntReader(recompress(("\n".join(stream) + "\n").encode()))
    got = [rec["kind"] for rec in r]
    check("newer minor still reads", r.verified and len(got) == 7, f"got {got}")
    check("newer minor is flagged as ahead", r.minor_ahead)

    print("== python writer self round-trip ==")
    w = AntWriter(tenantId=7, projectId=3, selection={"kind": "demo"})
    w.write("vertex", {"id": "v1", "name": "V", "label": "Antares.Deal", "properties": {}})
    w.write("evidence", {"id": "e1", "tenant_id": 7, "project_id": 3,
                          "source_uri": "antares://x", "source_type": "note",
                          "source_id": "n1", "content": "hello"})
    data = w.finish()
    r = AntReader(data)
    got = [rec["kind"] for rec in r]
    check("writer round-trip verified", r.verified and got == ["vertex", "evidence"])
    check("writer scope", r.manifest["tenantId"] == 7 and r.manifest["projectId"] == 3)

    failed = [c for c in CHECKS if not c[1]]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
