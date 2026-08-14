#!/usr/bin/env python3
"""OpenAntares conformance suite — Python binding vs the golden files.

Golden files are produced by the canonical Rust writer
(`cargo run -p antares-format --example gen_conformance`); this runner
proves the Python reference binding reads them byte-identically to the
spec, that every line validates against schema/ant.schema.json (when
`jsonschema` is installed), that negatives (tamper, truncation,
post-trailer data, bad version) are rejected, and that the Python
WRITER produces files the reader verifies (self round-trip).

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
from openantares import AntError, AntReader, AntWriter, validate  # noqa: E402

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
        check(f"{fname}: record kinds", s.record_kinds == exp["recordKinds"],
              f"got {s.record_kinds}")
        if "skippedKinds" in exp:
            check(f"{fname}: skipped kinds", s.skipped_kinds == exp["skippedKinds"],
                  f"got {s.skipped_kinds}")

    print("== schema validation (every golden line) ==")
    try:
        import jsonschema
    except ImportError:
        print("  SKIP  jsonschema not installed")
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
            # text differs per implementation, and pinning it would make
            # the fixture untestable outside Rust.
            expect_error(f"{fname}: rejected", lambda p=GOLDEN / fname: validate(str(p)), "")

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
