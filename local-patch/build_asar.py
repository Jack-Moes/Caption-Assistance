"""Rebuild Caption assistance's app.asar from app-src while preserving its file tree."""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path


BLOCK_SIZE = 4 * 1024 * 1024


def digest(data: bytes) -> dict[str, object]:
    blocks = [
        hashlib.sha256(data[pos : pos + BLOCK_SIZE]).hexdigest()
        for pos in range(0, len(data), BLOCK_SIZE)
    ]
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK_SIZE,
        "blocks": blocks,
    }


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: build_asar.py ORIGINAL_ASAR SOURCE_DIR OUTPUT_ASAR")

    original, source, output = map(Path, sys.argv[1:])
    with original.open("rb") as handle:
        _, _, _, json_size = struct.unpack("<4I", handle.read(16))
        header = json.loads(handle.read(json_size))

    payloads: list[bytes] = []
    offset = 0

    def update(node: dict, parts: tuple[str, ...] = ()) -> None:
        nonlocal offset
        for name, meta in node.get("files", {}).items():
            current = parts + (name,)
            if "files" in meta:
                update(meta, current)
                continue
            file_path = source.joinpath(*current)
            data = file_path.read_bytes()
            meta["size"] = len(data)
            meta["integrity"] = digest(data)
            meta["offset"] = str(offset)
            payloads.append(data)
            offset += len(data)

    update(header)
    encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pickle_size = (4 + len(encoded) + 3) & ~3
    outer_size = 4 + pickle_size
    padding = pickle_size - 4 - len(encoded)

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(struct.pack("<4I", 4, outer_size, pickle_size, len(encoded)))
        handle.write(encoded)
        handle.write(b"\0" * padding)
        for data in payloads:
            handle.write(data)

    print(f"built {output} ({output.stat().st_size} bytes, {len(payloads)} files)")


if __name__ == "__main__":
    main()
