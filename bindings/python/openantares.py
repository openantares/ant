"""OpenAntares `.ant` reference binding for Python.

Reader, writer, and validator for the OpenAntares container format
(spec: ../../SPEC.md, format version 0.1). Requires the `zstandard`
package; nothing else beyond the standard library.

    from openantares import AntReader, AntWriter, validate

    with open("world.ant", "rb") as f:
        reader = AntReader(f.read())
        for record in reader:          # dicts: {"kind": ..., "data": ...}
            ...
    assert reader.verified             # trailer sha256 + counts checked

    summary = validate("world.ant")    # raises AntError on any violation

CLI:  python3 openantares.py validate file.ant [file2.ant ...]
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
from dataclasses import dataclass, field

try:
    import zstandard
except ImportError as e:  # pragma: no cover
    raise ImportError("openantares needs the `zstandard` package: pip install zstandard") from e

FORMAT_VERSION = "0.1"

DATA_KINDS = (
    "schema_type",
    "vertex",
    "edge",
    "observation",
    "evidence",
    "belief",
    "vector",
)

# trailer count key per kind (counts are camelCase per spec §5)
_COUNT_KEY = {
    "schema_type": "schemaTypes",
    "vertex": "vertices",
    "edge": "edges",
    "observation": "observations",
    "evidence": "evidence",
    "belief": "beliefs",
    "vector": "vectors",
}


class AntError(Exception):
    """Any spec violation: not-ant, version, integrity, malformed JSON."""


@dataclass
class Counts:
    schema_types: int = 0
    vertices: int = 0
    edges: int = 0
    observations: int = 0
    evidence: int = 0
    beliefs: int = 0
    vectors: int = 0

    def as_trailer_dict(self) -> dict:
        return {
            "schemaTypes": self.schema_types,
            "vertices": self.vertices,
            "edges": self.edges,
            "observations": self.observations,
            "evidence": self.evidence,
            "beliefs": self.beliefs,
            "vectors": self.vectors,
        }

    def bump(self, kind: str) -> None:
        attr = {
            "schema_type": "schema_types",
            "vertex": "vertices",
            "edge": "edges",
            "observation": "observations",
            "evidence": "evidence",
            "belief": "beliefs",
            "vector": "vectors",
        }[kind]
        setattr(self, attr, getattr(self, attr) + 1)


@dataclass
class ReadSummary:
    manifest: dict
    counts: Counts
    record_kinds: list = field(default_factory=list)
    skipped_kinds: list = field(default_factory=list)
    verified: bool = False


class AntReader:
    """Streaming reader over the decompressed NDJSON. Iterate to get
    data records as dicts; after exhaustion, `verified` is True iff the
    trailer's sha256 and counts checked out (a spec violation raises)."""

    def __init__(self, data: bytes):
        try:
            raw = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data)).read()
        except zstandard.ZstdError as e:
            raise AntError(f"not an .ant stream: zstd: {e}") from e
        if not raw.endswith(b"\n"):
            raise AntError("integrity: stream ended without a trailer (truncated?)")
        self._lines = raw.decode("utf-8").split("\n")[:-1]  # drop empty tail
        if not self._lines:
            raise AntError("not an .ant stream: empty")
        first = self._lines[0]
        try:
            manifest = json.loads(first)
        except json.JSONDecodeError as e:
            raise AntError(f"json on line 1: {e}") from e
        if manifest.get("kind") != "manifest":
            raise AntError("not an .ant stream: first record is not a manifest")
        if manifest.get("format") != "antares":
            raise AntError(f"not an .ant stream: format `{manifest.get('format')}`")
        if manifest.get("version") != FORMAT_VERSION:
            raise AntError(
                f"unsupported format version {manifest.get('version')} "
                f"(reader supports {FORMAT_VERSION})"
            )
        self.manifest = manifest
        self.counts = Counts()
        self.skipped_kinds: list = []
        self.verified = False
        self._hasher = hashlib.sha256()
        self._hasher.update(first.encode("utf-8") + b"\n")
        self._pos = 1

    def __iter__(self):
        return self

    def __next__(self) -> dict:
        rec = self.next_record()
        if rec is None:
            raise StopIteration
        return rec

    def next_record(self):
        """Next data record dict, or None after a VERIFIED trailer."""
        while True:
            if self._pos >= len(self._lines):
                raise AntError("integrity: stream ended without a trailer (truncated?)")
            line = self._lines[self._pos]
            self._pos += 1
            pre_trailer_digest = self._hasher.hexdigest()
            self._hasher.update(line.encode("utf-8") + b"\n")
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                raise AntError(f"json on line {self._pos}: {e}") from e
            if not isinstance(rec, dict) or not isinstance(rec.get("kind"), str):
                raise AntError(f"json on line {self._pos}: record without string `kind`")
            kind = rec["kind"]
            if kind == "manifest":
                raise AntError("not an .ant stream: duplicate manifest")
            if kind == "trailer":
                if rec.get("sha256") != pre_trailer_digest:
                    raise AntError(
                        f"integrity: sha256 mismatch: trailer {rec.get('sha256')}, "
                        f"computed {pre_trailer_digest}"
                    )
                got = self.counts.as_trailer_dict()
                if rec.get("counts") != got:
                    raise AntError(
                        f"integrity: counts mismatch: trailer {rec.get('counts')}, read {got}"
                    )
                if self._pos != len(self._lines):
                    raise AntError("integrity: data after the trailer")
                self.verified = True
                return None
            if kind in DATA_KINDS:
                self.counts.bump(kind)
                return rec
            # forward compat: unknown kind, skipped but hashed
            self.skipped_kinds.append(kind)


class AntWriter:
    """Streaming writer. `write(kind, data)` per record, then `finish()`
    returns the compressed bytes with the trailer appended."""

    def __init__(self, manifest_fields: dict | None = None, level: int = 3, **kw):
        m = {"kind": "manifest", "format": "antares", "version": FORMAT_VERSION}
        m.update(manifest_fields or {})
        m.update(kw)
        for req in ("tenantId", "projectId"):
            if req not in m:
                raise AntError(f"manifest requires `{req}`")
        self._buf = io.BytesIO()
        self._compressor = zstandard.ZstdCompressor(level=level).stream_writer(
            self._buf, closefd=False
        )
        self._hasher = hashlib.sha256()
        self.counts = Counts()
        self._finished = False
        self._emit(m)

    def _emit(self, obj: dict) -> None:
        line = json.dumps(obj, separators=(",", ":")).encode("utf-8") + b"\n"
        self._hasher.update(line)
        self._compressor.write(line)

    def write(self, kind: str, data: dict) -> None:
        if self._finished:
            raise AntError("writer already finished")
        if kind not in DATA_KINDS:
            raise AntError(f"unknown record kind `{kind}`")
        self.counts.bump(kind)
        self._emit({"kind": kind, "data": data})

    def finish(self) -> bytes:
        if self._finished:
            raise AntError("writer already finished")
        trailer = {
            "kind": "trailer",
            "counts": self.counts.as_trailer_dict(),
            "sha256": self._hasher.hexdigest(),
        }
        line = json.dumps(trailer, separators=(",", ":")).encode("utf-8") + b"\n"
        self._compressor.write(line)
        self._compressor.flush(zstandard.FLUSH_FRAME)
        self._finished = True
        return self._buf.getvalue()


def validate(path: str) -> ReadSummary:
    """Read the whole file, enforcing every spec rule. Raises AntError
    on any violation; returns a summary on success."""
    with open(path, "rb") as f:
        reader = AntReader(f.read())
    kinds = [rec["kind"] for rec in reader]
    return ReadSummary(
        manifest=reader.manifest,
        counts=reader.counts,
        record_kinds=kinds,
        skipped_kinds=reader.skipped_kinds,
        verified=reader.verified,
    )


def _main(argv):
    if len(argv) < 3 or argv[1] != "validate":
        print("usage: python3 openantares.py validate <file.ant> [...]", file=sys.stderr)
        return 64
    rc = 0
    for path in argv[2:]:
        try:
            s = validate(path)
            print(
                f"{path}: OK  version={s.manifest['version']} "
                f"records={len(s.record_kinds)} skipped={len(s.skipped_kinds)} "
                f"counts={s.counts.as_trailer_dict()}"
            )
        except AntError as e:
            print(f"{path}: FAIL  {e}", file=sys.stderr)
            rc = 65
    return rc


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
