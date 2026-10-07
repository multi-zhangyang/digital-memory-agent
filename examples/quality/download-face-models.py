"""Provision only pinned InsightFace evaluation files; inference stays offline."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def valid(path: Path, item: dict) -> bool:
    if not path.is_file() or path.stat().st_size != item["bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == item["sha256"]


def download(path: Path, item: dict) -> None:
    if valid(path, item):
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".part")
    if valid(partial, item):
        partial.replace(path)
        return
    offset = partial.stat().st_size if partial.exists() else 0
    if offset >= item["bytes"]:
        raise ValueError("Invalid complete partial download: " + path.name)
    headers = {"User-Agent": "DigitalMemoryEvaluation/1.0"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    with urlopen(Request(item["url"], headers=headers), timeout=60) as response:
        append = offset > 0 and response.status == 206
        if append and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
            raise ValueError("Invalid resume response")
        with partial.open("ab" if append else "wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                if output.tell() > item["bytes"]:
                    raise ValueError("Download exceeds pinned size")
    if not valid(partial, item):
        raise ValueError("Download checksum mismatch: " + path.name)
    partial.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, default=ROOT / ".data/memory-worker/insightface-eval")
    args = parser.parse_args()
    os.umask(0o077)
    root = args.directory.resolve()
    manifest = json.loads(Path(__file__).with_name("face-models.json").read_text())
    root.mkdir(parents=True, exist_ok=True)
    for archive in manifest["archives"]:
        path = root / "downloads" / archive["name"]
        entries = [f for f in manifest["files"] if f.get("archive") == archive["name"]]
        if all(valid(root / e["path"], e) for e in entries):
            continue
        download(path, archive)
        with zipfile.ZipFile(path) as source:
            for entry in entries:
                target = (root / entry["path"]).resolve()
                if not target.is_relative_to(root):
                    raise ValueError("Invalid target path")
                if valid(target, entry):
                    continue
                member = source.getinfo(entry["member"])
                if member.file_size != entry["bytes"]:
                    raise ValueError("Invalid archive member size")
                target.parent.mkdir(parents=True, exist_ok=True)
                partial = target.with_suffix(".part")
                with source.open(member) as src, partial.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                if not valid(partial, entry):
                    raise ValueError("Extracted checksum mismatch")
                partial.replace(target)
    for entry in manifest["files"]:
        target = (root / entry["path"]).resolve()
        if not target.is_relative_to(root):
            raise ValueError("Invalid target path")
        if entry.get("url"):
            download(target, entry)
        elif entry.get("generated") == "empty-package-init":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"")
        if not valid(target, entry):
            raise ValueError("Provisioned file mismatch: " + entry["path"])
    print(json.dumps({"directory": str(root), "verifiedFiles": len(manifest["files"]),
                      "weightsLicense": manifest["weightsLicense"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
