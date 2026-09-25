"""OpenAntares `.ant` reference binding for Python.

Reader, writer, and validator for the OpenAntares container format
(spec: ../../SPEC.md, format versions 0.7 and 1.0 — 1.0 is a file that
carries stored originals, §5.6). Requires the `zstandard`
package; nothing else beyond the standard library.

    from openantares import AntReader, AntWriter, validate, decode_property

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

# ---- generated from the Rust types by gen_schema: format facts ----
FORMAT_MAJOR = 0
FORMAT_MINOR = 7
FORMAT_VERSION = f"{FORMAT_MAJOR}.{FORMAT_MINOR}"
# Files that carry stored originals (SPEC §5.6).
ORIGINALS_FORMAT_MAJOR = 1
ORIGINALS_FORMAT_MINOR = 0
ORIGINALS_FORMAT_VERSION = f"{ORIGINALS_FORMAT_MAJOR}.{ORIGINALS_FORMAT_MINOR}"

DATA_KINDS = (
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
    "vertex_tombstone": "vertexTombstones",
    "edge_tombstone": "edgeTombstones",
    "contradiction_case": "contradictionCases",
    "relationship_proposal": "relationshipProposals",
    "ontology_revision": "ontologyRevisions",
    "original_chunk": "originalChunks",
    "original_source": "originalSources",
}

# Trailer keys added after the first version. Absent in an older
# trailer, where they mean zero.
_LATER_COUNT_KEYS = (
    "vertexTombstones",
    "edgeTombstones",
    "contradictionCases",
    "relationshipProposals",
    "ontologyRevisions",
)

# Trailer keys a writer omits when zero, so a file that never uses
# the kind keeps its earlier trailer bytes.
_OMITTED_WHEN_ZERO = (
    "originalChunks",
    "originalSources",
)
# ---- end generated: format facts ----

# ---------------------------------------------------------------------
# Cleaned-text derivations (v1.0): the structural rules of the Rust
# `ant_types::Derivation::validate`, in its order and with its messages.
# ---------------------------------------------------------------------

NORMALIZED_TEXT_CONTRACT = "antares.normalized-text/v1"
_DERIVATION_FIELDS = frozenset((
    "contract", "primaryEvidenceId", "assetId", "sha256", "byteLength", "normalizer",
    "jobId", "segment", "textSha256", "textByteLength"))
_NORMALIZER_FIELDS = frozenset(("name", "version", "configurationSha256"))
_SEGMENT_FIELDS = frozenset(("index", "locator", "coverage"))
_TOKEN = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-")
_ASSET = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
_HEX = frozenset(b"0123456789abcdef")
_U64_MAX = (1 << 64) - 1
DERIVATION_LOCATOR_MAX_BYTES = 2 * 1024
DERIVATION_COVERAGE_MAX_BYTES = 8 * 1024
DERIVATION_COVERAGE_MAX_DEPTH = 64


def _nests_deeper(v, levels: int) -> bool:
    """Whether a JSON value nests deeper than `levels` arrays/objects, the
    value itself counting as one level when it is one."""
    if not isinstance(v, (dict, list)):
        return False
    return levels == 0 or any(
        _nests_deeper(c, levels - 1) for c in (v.values() if isinstance(v, dict) else v))


def _has_control(s: str) -> bool:
    # Rust `char::is_control`: general category Cc.
    return any(ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in s)


def _is_token(s, max_len: int) -> bool:
    return (isinstance(s, str) and 1 <= len(s.encode("utf-8")) <= max_len
            and set(s.encode("utf-8")) <= _TOKEN)


def _is_hex64(s) -> bool:
    return isinstance(s, str) and len(s) == 64 and set(s.encode("utf-8")) <= _HEX


def _is_u64(n) -> bool:
    # The literal `-0` is a double to the Rust reader, never a u64.
    return (isinstance(n, int) and not isinstance(n, (bool, _NegativeZero))
            and 0 <= n <= _U64_MAX)


SOURCE_REFERENCE_SOURCE_MAX_BYTES = 16 * 1024
SOURCE_REFERENCE_SOURCE_MAX_DEPTH = 64
_I64_MIN = -(1 << 63)


class _NegativeZero(int):
    """The JSON literal `-0`: the integer 0 to callers, but the Rust reader
    holds it as the double -0.0 (serialized `-0.0`), so its canonical size
    differs from `0`."""


def _parse_int(literal: str) -> int:
    return _NegativeZero(0) if literal == "-0" else int(literal)


def _parse_float(literal: str) -> float:
    # The Rust reader refuses a number no double can hold (serde_json:
    # "number out of range"); never let it become an infinity here.
    value = float(literal)
    if value != value or value in (float("inf"), float("-inf")):
        raise AntError(f"number out of range: {literal}")
    return value


def _refuse_constant(name: str):
    # NaN, Infinity and -Infinity are not JSON; Python's parser would take them.
    raise AntError(f"number out of range: {name} is not a JSON number")


def _loads(text: str):
    return json.loads(text, parse_int=_parse_int, parse_float=_parse_float,
                      parse_constant=_refuse_constant)


def _float_text(x: float) -> str:
    """A finite double exactly as the Rust reader serializes it (serde_json,
    whose float writer is `zmij`): shortest round-trip digits, in plain
    notation when the decimal exponent is -5..=15, otherwise as a mantissa
    and an exponent that always carries its sign (`1e+16`, `1e-7`)."""
    if x == 0:
        return "-0.0" if str(x).startswith("-") else "0.0"
    from decimal import Decimal
    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x))).as_tuple()
    digits = "".join(map(str, t.digits)).rstrip("0")
    k = t.exponent + (len(t.digits) - len(digits))
    n = len(digits)
    kk = n + k
    if 0 <= k and kk <= 16:
        out = digits + "0" * (kk - n) + ".0"
    elif 0 < kk <= 16:
        out = digits[:kk] + "." + digits[kk:]
    elif -5 < kk <= 0:
        out = "0." + "0" * (-kk) + digits
    else:
        mantissa = digits if n == 1 else f"{digits[0]}.{digits[1:]}"
        out = f"{mantissa}e{kk - 1:+d}"
    return sign + out


def canonical_json_size(v) -> int:
    """Bytes of `v` as the Rust reader serializes it compactly (serde_json):
    the accounting the 8 KiB coverage and 16 KiB source bounds use in every
    reader. Integers in [-2^63, 2^64-1] are written exactly; `-0` and every
    other number as `_float_text` of its double; strings JSON-escaped, UTF-8."""
    if v is None or v is True:
        return 4
    if v is False:
        return 5
    if isinstance(v, _NegativeZero):
        return 4
    if isinstance(v, int):
        return len(str(v)) if _I64_MIN <= v <= _U64_MAX else len(_float_text(float(v)))
    if isinstance(v, float):
        return len(_float_text(v))
    if isinstance(v, str):
        return len(json.dumps(v, ensure_ascii=False).encode("utf-8", "surrogatepass"))
    if isinstance(v, list):
        return 2 + max(0, len(v) - 1) + sum(canonical_json_size(x) for x in v)
    if isinstance(v, dict):
        return 2 + max(0, len(v) - 1) + sum(
            canonical_json_size(k) + 1 + canonical_json_size(x) for k, x in v.items())
    raise TypeError(f"not a JSON value: {type(v).__name__}")


def _is_asset_id(s) -> bool:
    return (isinstance(s, str) and 16 <= len(s.encode("utf-8")) <= 128
            and set(s.encode("utf-8")) <= _ASSET)


def _source_blob_problem(b) -> str | None:
    """The first structural problem of an Evidence `source_blob`, or None:
    the typed shape, then the Rust `SourceBlob::validate`, in its order and
    with its messages."""
    if not isinstance(b, dict) or not all(
            isinstance(b.get(k), str) for k in ("assetId", "sha256", "mediaType", "fileName")) \
            or not _is_u64(b.get("byteLength")):
        return "malformed `evidence` record: sourceBlob has missing or invalid fields"
    if not _is_asset_id(b["assetId"]):
        return "sourceBlob.assetId must be 16..=128 characters of [A-Za-z0-9_-]"
    if not _is_hex64(b["sha256"]):
        return "sourceBlob.sha256 must be 64 lowercase hex characters"
    mt = b["mediaType"].encode("utf-8")
    if not mt or len(mt) > 255 or not all(0x20 <= c < 0x7F for c in mt):
        return "sourceBlob.mediaType must be 1..=255 printable ASCII bytes"
    fn = b["fileName"]
    if not fn or len(fn.encode("utf-8")) > 1024 or _has_control(fn):
        return "sourceBlob.fileName must be 1..=1024 bytes with no control characters"
    return None


def _source_reference_problem(r) -> str | None:
    """The first structural problem of an `original_source` record, or
    None: the typed shape, then the Rust `SourceReference::validate`, in its
    order and with its messages. The source bound uses
    `canonical_json_size`."""
    if not (isinstance(r, dict)
            and all(isinstance(r.get(k), str)
                    for k in ("evidenceId", "assetId", "sha256", "referenceId"))
            and _is_u64(r.get("byteLength")) and "source" in r
            # recordedAt: a string; Rust's datetime parser remains the finer
            # check (a binding must not refuse a time Rust accepts).
            and isinstance(r.get("recordedAt"), str)
            and (r.get("author") is None or isinstance(r["author"], dict))):
        return "malformed `original_source` record: reference has missing or invalid fields"
    if not _is_token(r["referenceId"], 128):
        return "reference.referenceId must be 1..=128 characters of [A-Za-z0-9_.:-]"
    if not isinstance(r["source"], dict):
        return "reference.source must be a JSON object"
    if canonical_json_size(r["source"]) > SOURCE_REFERENCE_SOURCE_MAX_BYTES:
        return f"reference.source exceeds {SOURCE_REFERENCE_SOURCE_MAX_BYTES} bytes serialized"
    if _nests_deeper(r["source"], SOURCE_REFERENCE_SOURCE_MAX_DEPTH):
        return f"reference.source nests deeper than {SOURCE_REFERENCE_SOURCE_MAX_DEPTH} levels"
    eid = r["evidenceId"]
    if not eid or _has_control(eid):
        return "reference.evidenceId must be non-empty with no control characters"
    if not _is_asset_id(r["assetId"]) or not _is_hex64(r["sha256"]):
        return "reference.assetId/sha256 are malformed"
    return None


def _derivation_problem(d) -> str | None:
    """The first structural problem of a derivation, or None: exactly the
    rules the Rust reader applies (the typed shape, then `validate`). The
    coverage bound uses `canonical_json_size`, the Rust reader's own
    accounting."""
    if not isinstance(d, dict) or set(d) != _DERIVATION_FIELDS:
        return "malformed `evidence` record: derivation has missing or unknown fields"
    n, seg = d["normalizer"], d["segment"]
    if not isinstance(n, dict) or set(n) != _NORMALIZER_FIELDS:
        return "malformed `evidence` record: derivation.normalizer has missing or unknown fields"
    if not isinstance(seg, dict) or set(seg) != _SEGMENT_FIELDS:
        return "malformed `evidence` record: derivation.segment has missing or unknown fields"
    if not (_is_u64(d["byteLength"]) and _is_u64(d["textByteLength"])
            and _is_u64(seg["index"])):
        return ("malformed `evidence` record: derivation byteLength/textByteLength/"
                "segment.index must be u64 integers")
    if d["contract"] != NORMALIZED_TEXT_CONTRACT:
        return f"derivation.contract must be `{NORMALIZED_TEXT_CONTRACT}`"
    pid = d["primaryEvidenceId"]
    if not isinstance(pid, str) or not pid or _has_control(pid):
        return "derivation.primaryEvidenceId must be non-empty with no control characters"
    aid = d["assetId"]
    if not (isinstance(aid, str) and 16 <= len(aid.encode("utf-8")) <= 128
            and set(aid.encode("utf-8")) <= _ASSET) or not _is_hex64(d["sha256"]):
        return "derivation.assetId/sha256 are malformed"
    if not _is_token(n["name"], 64) or not _is_token(n["version"], 64):
        return ("derivation.normalizer.name/version must be 1..=64 characters of "
                "[A-Za-z0-9_.:-]")
    if not _is_hex64(n["configurationSha256"]):
        return "derivation.normalizer.configurationSha256 must be 64 lowercase hex characters"
    if not _is_token(d["jobId"], 128):
        return "derivation.jobId must be 1..=128 characters of [A-Za-z0-9_.:-]"
    loc = seg["locator"]
    if (not isinstance(loc, str) or not loc
            or len(loc.encode("utf-8")) > DERIVATION_LOCATOR_MAX_BYTES or _has_control(loc)):
        return (f"derivation.segment.locator must be 1..={DERIVATION_LOCATOR_MAX_BYTES} "
                "bytes with no control characters")
    cov = seg["coverage"]
    if not isinstance(cov, dict):
        return "derivation.segment.coverage must be a JSON object"
    if canonical_json_size(cov) > DERIVATION_COVERAGE_MAX_BYTES:
        return (f"derivation.segment.coverage exceeds {DERIVATION_COVERAGE_MAX_BYTES} "
                "bytes serialized")
    if _nests_deeper(cov, DERIVATION_COVERAGE_MAX_DEPTH):
        return f"derivation.segment.coverage nests deeper than {DERIVATION_COVERAGE_MAX_DEPTH} levels"
    if not _is_hex64(d["textSha256"]):
        return "derivation.textSha256 must be 64 lowercase hex characters"
    return None


class AntError(Exception):
    """Any spec violation: not-ant, version, integrity, malformed JSON."""


def parse_version(s) -> tuple[int, int] | None:
    """`MAJOR.MINOR` -> (major, minor). A bare `MAJOR` means `MAJOR.0`.

    Returns None if the value does not parse, which the caller must
    treat as an error — guessing at a version is how a reader ends up
    misinterpreting records.
    """
    if not isinstance(s, str):
        return None
    parts = s.split(".")
    if len(parts) == 1:
        parts.append("0")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        return None
    return int(parts[0]), int(parts[1])


# ---------------------------------------------------------------------
# Property values (v0.3)
# ---------------------------------------------------------------------

# v0.2 carried property values as bare JSON scalars. Those five shapes
# are UNCHANGED in v0.3, which adds a tagged envelope for the SQL types
# that are otherwise indistinguishable from strings — a DATE, a UUID and
# a TEXT are all JSON strings, so an untagged reader cannot tell them
# apart and the type is lost on the first round-trip.
_ENVELOPE_TAGS = frozenset(
    {"decimal", "date", "time", "timestamp", "uuid", "bytes", "int32", "int16", "array"}
)


def is_property_envelope(v) -> bool:
    """True for a well-formed v0.3 tagged value.

    The guard is deliberately strict: EXACTLY the two keys `$ant` and
    `v`, and a known tag. A producer's own document that happens to have
    a `$ant` field is still that document, not a typed value, and must
    round-trip as one.
    """
    return (
        isinstance(v, dict)
        and len(v) == 2
        and "$ant" in v
        and "v" in v
        and v["$ant"] in _ENVELOPE_TAGS
    )


def decode_property(v):
    """Return `(type_name, payload)` for a property value.

    `type_name` is one of the v0.3 tags for an envelope, or `None` for a
    bare v0.2 scalar (in which case `payload` is the value itself).
    Nested arrays are decoded element-wise.

    The payload is returned AS TEXT for `decimal`, `date`, `time`,
    `timestamp` and `uuid`, and as base64 text for `bytes`. In
    particular a decimal is NEVER converted to `float`: Python's float
    is an IEEE double, so `float("12345678901234567.89")` silently
    becomes a different number. Use `decimal.Decimal(payload)` if you
    need arithmetic.
    """
    if not is_property_envelope(v):
        return (None, v)
    tag, payload = v["$ant"], v["v"]
    if tag == "array":
        return (tag, [decode_property(item) for item in payload])
    return (tag, payload)


def encode_property(type_name, payload):
    """Build a v0.3 envelope. `type_name=None` emits the bare value."""
    if type_name is None:
        return payload
    if type_name not in _ENVELOPE_TAGS:
        raise AntError(f"unknown property type `{type_name}`")
    return {"$ant": type_name, "v": payload}


# ---- generated from the Rust types by gen_schema: counts ----
@dataclass
class Counts:
    schemaTypes: int = 0
    vertices: int = 0
    edges: int = 0
    observations: int = 0
    evidence: int = 0
    beliefs: int = 0
    vectors: int = 0
    vertexTombstones: int = 0
    edgeTombstones: int = 0
    contradictionCases: int = 0
    relationshipProposals: int = 0
    ontologyRevisions: int = 0
    originalChunks: int = 0
    originalSources: int = 0

    def as_trailer_dict(self) -> dict:
        counts = {
            "schemaTypes": self.schemaTypes,
            "vertices": self.vertices,
            "edges": self.edges,
            "observations": self.observations,
            "evidence": self.evidence,
            "beliefs": self.beliefs,
            "vectors": self.vectors,
            "vertexTombstones": self.vertexTombstones,
            "edgeTombstones": self.edgeTombstones,
            "contradictionCases": self.contradictionCases,
            "relationshipProposals": self.relationshipProposals,
            "ontologyRevisions": self.ontologyRevisions,
            "originalChunks": self.originalChunks,
            "originalSources": self.originalSources,
        }
        return {k: v for k, v in counts.items() if v or k not in _OMITTED_WHEN_ZERO}

    def bump(self, kind: str) -> None:
        attr = {
            "schema_type": "schemaTypes",
            "vertex": "vertices",
            "edge": "edges",
            "observation": "observations",
            "evidence": "evidence",
            "belief": "beliefs",
            "vector": "vectors",
            "vertex_tombstone": "vertexTombstones",
            "edge_tombstone": "edgeTombstones",
            "contradiction_case": "contradictionCases",
            "relationship_proposal": "relationshipProposals",
            "ontology_revision": "ontologyRevisions",
            "original_chunk": "originalChunks",
            "original_source": "originalSources",
        }[kind]
        setattr(self, attr, getattr(self, attr) + 1)
# ---- end generated: counts ----

@dataclass
class ReadSummary:
    manifest: dict
    counts: Counts
    record_kinds: list = field(default_factory=list)
    skipped_kinds: list = field(default_factory=list)
    verified: bool = False
    #: File declares a newer minor than this reader implements, so the
    #: caller received a subset of what the file contains.
    minor_ahead: bool = False


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
            manifest = _loads(first)
        except json.JSONDecodeError as e:
            raise AntError(f"json on line 1: {e}") from e
        if manifest.get("kind") != "manifest":
            raise AntError("not an .ant stream: first record is not a manifest")
        if manifest.get("format") != "antares":
            raise AntError(f"not an .ant stream: format `{manifest.get('format')}`")
        # Version compatibility policy (spec §2): same major reads at
        # ANY minor, because minor bumps are additive-only by contract
        # and unknown kinds are skipped-but-hashed below. A different
        # major is refused — it means field meanings or the container
        # framing changed, so reading it here would silently
        # misinterpret records rather than fail.
        parsed = parse_version(manifest.get("version"))
        if parsed is None:
            raise AntError(
                f"manifest version `{manifest.get('version')}` is not MAJOR.MINOR; "
                f"this reader implements {FORMAT_VERSION}"
            )
        major, minor = parsed
        # This reader implements two majors: 0.x, and 1.x — files that
        # carry stored originals (§5.6). A 0.x-only reader refuses 1.x at
        # this point, before any record, which is why originals are a major.
        if major not in (FORMAT_MAJOR, ORIGINALS_FORMAT_MAJOR):
            raise AntError(
                f"file is format v{major}.{minor}, this reader implements "
                f"v{FORMAT_VERSION} and v{ORIGINALS_FORMAT_VERSION}. Major versions are not "
                "compatible: a major bump means field meanings or the container framing "
                "changed, so reading it here would silently misinterpret records. Upgrade "
                f"the reader to a v{major}.x build, or re-export the file at v{FORMAT_MAJOR}."
            )
        #: File declares a newer minor than this reader implements: it
        #: is readable, but the caller got a SUBSET of what is in it.
        #: Surfaced so a tool reporting completeness can say so.
        known_minor = ORIGINALS_FORMAT_MINOR if major == ORIGINALS_FORMAT_MAJOR else FORMAT_MINOR
        self.minor_ahead = minor > known_minor
        #: Whether this file may carry stored originals (1.x).
        self._carries_originals = major >= ORIGINALS_FORMAT_MAJOR
        #: The original whose chunks must come next, if any.
        self._original: dict | None = None
        #: The original just completed, whose source references may follow.
        self._completed: dict | None = None
        #: The primary whose cleaned-text derivatives are being read.
        self._derivatives_of: dict | None = None
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
                rec = _loads(line)
            except json.JSONDecodeError as e:
                raise AntError(f"json on line {self._pos}: {e}") from e
            if not isinstance(rec, dict) or not isinstance(rec.get("kind"), str):
                raise AntError(f"json on line {self._pos}: record without string `kind`")
            kind = rec["kind"]
            if kind == "manifest":
                raise AntError("not an .ant stream: duplicate manifest")
            if kind == "trailer":
                if self._original is not None:
                    raise AntError(
                        f"integrity: the original of evidence {self._original['evidenceId']} "
                        f"ends at byte {self._original['offset']} of "
                        f"{self._original['byteLength']}: chunks missing"
                    )
                if rec.get("sha256") != pre_trailer_digest:
                    raise AntError(
                        f"integrity: sha256 mismatch: trailer {rec.get('sha256')}, "
                        f"computed {pre_trailer_digest}"
                    )
                got = self.counts.as_trailer_dict()
                # A v0.1 trailer omits the tombstone keys; they mean
                # zero there, so default them before comparing rather
                # than failing an older file for a field it predates.
                trailer_counts = dict(rec.get("counts") or {})
                for k in _LATER_COUNT_KEYS:
                    trailer_counts.setdefault(k, 0)
                # A NEWER minor may count kinds this binding skipped as
                # unknown. Those keys are not ours to check (spec §7/§8):
                # failing on them would make every additive kind a
                # breaking change, which is what the v0.3 binding did.
                known = {k: v for k, v in trailer_counts.items() if k in got}
                if known != got:
                    raise AntError(
                        f"integrity: counts mismatch: trailer {trailer_counts}, read {got}"
                    )
                if self._pos != len(self._lines):
                    raise AntError("integrity: data after the trailer")
                self.verified = True
                return None
            if kind in DATA_KINDS:
                self.counts.bump(kind)
                self._check_originals(rec)
                return rec
            # forward compat: unknown kind, skipped but hashed
            self.skipped_kinds.append(kind)


    def _check_derivative(self, data: dict) -> None:
        """A cleaned-text derivative (v1.0) follows its primary's original and
        source references, or another derivative of the same primary, in
        strictly increasing (jobId, index); binds exactly that original; and
        its content is exactly the text it names."""
        d = data["derivation"]
        eid = data.get("id")
        if not self._carries_originals:
            raise AntError(f"integrity: evidence {eid} is a derivative in a 0.x file")
        # `.ant` Evidence fields are snake_case: the original is `source_blob`.
        if data.get("source_blob") is not None:
            raise AntError(f"integrity: evidence {eid} carries both a derivation and an original")
        problem = _derivation_problem(d)
        if problem is not None:
            raise AntError(f"integrity: {problem}")
        content = data.get("content", "")
        raw = content.encode("utf-8")
        if (hashlib.sha256(raw).hexdigest() != d.get("textSha256")
                or len(raw) != d.get("textByteLength")):
            raise AntError(
                f"integrity: derivative {eid}: content is not the text its derivation names"
            )
        group = self._completed or self._derivatives_of
        if group is None:
            raise AntError(
                f"integrity: derivative {eid} does not follow its primary "
                f"{d.get('primaryEvidenceId')}'s original"
            )
        if (d.get("primaryEvidenceId"), d.get("assetId"), d.get("sha256"),
                d.get("byteLength")) != (group["evidenceId"], group["assetId"],
                                         group["sha256"], group["byteLength"]):
            raise AntError(
                f"integrity: derivative {eid} does not bind to the original of evidence "
                f"{group['evidenceId']} it follows"
            )
        seg = d.get("segment") or {}
        key = (d.get("jobId"), seg.get("index"))
        last = group.get("lastDerivative") if group is self._derivatives_of else None
        if last is not None and key <= last:
            raise AntError(
                f"integrity: derivative {eid} of evidence {group['evidenceId']} is out of "
                "(jobId, index) order or repeated"
            )
        self._derivatives_of = {k: group[k] for k in
                                ("evidenceId", "assetId", "sha256", "byteLength")}
        self._derivatives_of["lastDerivative"] = key
        self._completed = None

    def _check_originals(self, rec: dict) -> None:
        """Spec §5.6, as the Rust reader enforces it: an evidence with a
        `sourceBlob` is followed by exactly its chunks — contiguous, the
        right lengths, each and all matching their SHA-256 — and nothing
        else interrupts them. A 0.x file may carry neither."""
        import base64
        import binascii

        kind, data = rec["kind"], rec.get("data") or {}
        if kind == "original_chunk":
            if not self._carries_originals:
                raise AntError("integrity: original_chunk in a 0.x file; originals need v1.0")
            p = self._original
            if p is None:
                raise AntError(
                    f"integrity: original_chunk {data.get('index')} of evidence "
                    f"{data.get('evidenceId')} does not follow its evidence record"
                )
            if data.get("evidenceId") != p["evidenceId"] or data.get("assetId") != p["assetId"]:
                raise AntError("integrity: original_chunk for a different evidence/asset")
            if data.get("index") != p["index"] or data.get("byteOffset") != p["offset"]:
                raise AntError(
                    f"integrity: original of evidence {p['evidenceId']}: chunk "
                    f"{data.get('index')} at {data.get('byteOffset')} where chunk {p['index']} "
                    f"at {p['offset']} is next (missing or reordered chunk)"
                )
            try:
                raw = base64.b64decode(data.get("bytes", ""), validate=True)
            except (binascii.Error, ValueError) as e:
                raise AntError(f"integrity: original_chunk bytes are not base64: {e}") from e
            n = len(raw)
            if n == 0 or hashlib.sha256(raw).hexdigest() != data.get("sha256"):
                raise AntError(
                    f"integrity: original of evidence {p['evidenceId']}: chunk {p['index']} "
                    "is empty or does not match its sha256"
                )
            first = p["chunkLen"] if p["chunkLen"] is not None else n
            p["chunkLen"] = first
            end = p["offset"] + n
            if n > first or end > p["byteLength"] or (n < first and end != p["byteLength"]):
                raise AntError(
                    f"integrity: original of evidence {p['evidenceId']}: chunk {p['index']} "
                    f"has length {n}; chunks are {first} bytes except a shorter last one"
                )
            p["hasher"].update(raw)
            p["index"] += 1
            p["offset"] = end
            if end == p["byteLength"]:
                self._original = None
                if p["hasher"].hexdigest() != p["sha256"]:
                    raise AntError(
                        f"integrity: original of evidence {p['evidenceId']} does not match "
                        "its sourceBlob.sha256"
                    )
                self._completed = {"evidenceId": p["evidenceId"], "assetId": p["assetId"],
                                   "sha256": p["sha256"], "byteLength": p["byteLength"],
                                   "last": None}
            return
        if kind == "original_source":
            if not self._carries_originals:
                raise AntError("integrity: original_source in a 0.x file; originals need v1.0")
            if self._original is not None:
                raise AntError("integrity: an original_source interrupts an original's chunks")
            c = self._completed
            if c is None:
                raise AntError(
                    f"integrity: original_source {data.get('referenceId')} does not follow "
                    "its original"
                )
            problem = _source_reference_problem(data)
            if problem is not None:
                raise AntError(f"integrity: {problem}")
            if (data.get("evidenceId"), data.get("assetId"), data.get("sha256"),
                    data.get("byteLength")) != (c["evidenceId"], c["assetId"], c["sha256"],
                                                c["byteLength"]):
                raise AntError(
                    f"integrity: original_source {data.get('referenceId')} does not bind to "
                    f"the original of evidence {c['evidenceId']}"
                )
            rid = data["referenceId"]
            if c["last"] is not None and rid <= c["last"]:
                raise AntError(
                    f"integrity: original_source {rid} of evidence {c['evidenceId']} is out of "
                    "order or repeated"
                )
            c["last"] = rid
            return
        if self._original is not None:
            raise AntError(
                f"integrity: the original of evidence {self._original['evidenceId']} ends at "
                f"byte {self._original['offset']} of {self._original['byteLength']}: "
                "chunks missing"
            )
        if kind == "evidence" and data.get("derivation") is not None:
            self._check_derivative(data)
            return
        self._completed = None
        self._derivatives_of = None
        blob = data.get("source_blob") if kind == "evidence" else None
        if blob is None:
            return
        if not self._carries_originals:
            raise AntError(
                f"integrity: evidence {data.get('id')} has a sourceBlob in a 0.x file; "
                "originals need v1.0"
            )
        problem = _source_blob_problem(blob)
        if problem is not None:
            raise AntError(f"integrity: {problem}")
        length = blob["byteLength"]
        if length == 0:
            if blob.get("sha256") != hashlib.sha256(b"").hexdigest():
                raise AntError(
                    f"integrity: evidence {data.get('id')} declares an empty original with "
                    "the wrong sha256"
                )
            self._completed = {"evidenceId": data.get("id"), "assetId": blob.get("assetId"),
                               "sha256": blob.get("sha256"), "byteLength": 0, "last": None}
            return
        self._original = {
            "evidenceId": data.get("id"),
            "assetId": blob.get("assetId"),
            "byteLength": length,
            "sha256": blob.get("sha256"),
            "index": 0,
            "offset": 0,
            "chunkLen": None,
            "hasher": hashlib.sha256(),
        }


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
        minor_ahead=reader.minor_ahead,
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
