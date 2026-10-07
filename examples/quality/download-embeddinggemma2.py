"""Download one pinned public checkpoint for the isolated embedding experiment."""
from __future__ import annotations

import argparse
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time
from urllib.request import Request, urlopen

MODEL = "google/embeddinggemma-2"
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
WEIGHTS_SHA256 = "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download_large(url: str, partial: Path, size: int) -> None:
    """Bounded parallel ranges with resumable parts and final whole-file verification."""
    block_size = 4 * 1024 * 1024
    parts = partial.with_name(partial.name + ".parts")
    parts.mkdir(exist_ok=True, mode=0o700)
    # Preserve the completed prefix from a previous sequential download.
    if partial.exists() and not any(parts.iterdir()):
        with partial.open("rb") as source:
            for index in range(size // block_size + 1):
                block = source.read(block_size)
                if len(block) == min(block_size, size - index * block_size) and block:
                    (parts / str(index)).write_bytes(block)
                else:
                    break

    def chunk(index: int) -> Path:
        start = index * block_size
        end = min(size, start + block_size) - 1
        target = parts / str(index)
        if target.is_file() and target.stat().st_size == end - start + 1:
            return target
        staged = parts / f"{index}.tmp"
        for attempt in range(3):
            try:
                request = Request(url + f"?download=true&offset={start}", headers={"Range": f"bytes={start}-{end}"})
                with urlopen(request, timeout=60) as response, staged.open("wb") as output:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}":
                        raise ValueError("Invalid range response")
                    received = 0
                    for data in iter(lambda: response.read(256 * 1024), b""):
                        received += len(data)
                        if received > end - start + 1:
                            raise ValueError("Oversized range response")
                        output.write(data)
                if staged.stat().st_size != end - start + 1:
                    raise ValueError("Incomplete range response")
                staged.replace(target)
                if index % 32 == 0:
                    print(json.dumps({"stage": "weights", "completedParts": len(list(parts.glob("[0-9]*")))}), flush=True)
                return target
            except Exception:
                staged.unlink(missing_ok=True)
                if attempt == 2:
                    raise RuntimeError("Checkpoint range download failed") from None
                time.sleep(attempt + 1)
        raise RuntimeError("Unreachable download state")

    with ThreadPoolExecutor(max_workers=24) as pool:
        ordered = list(pool.map(chunk, range((size + block_size - 1) // block_size)))
    with partial.open("wb") as output:
        partial.chmod(0o600)
        for path in ordered:
            with path.open("rb") as source:
                for data in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    root = args.destination.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with urlopen(f"https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true", timeout=30) as response:
        repository = json.load(response)
    if repository["sha"] != REVISION:
        raise ValueError("Unexpected model revision")

    def download(entry: dict) -> dict:
        relative = entry["rfilename"]
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or target.suffix not in (".json", ".jinja", ".md", ".model", ".safetensors"):
            raise ValueError("Unexpected checkpoint file")
        expected_hash = (entry.get("lfs") or {}).get("sha256")
        if relative == "model.safetensors" and expected_hash != WEIGHTS_SHA256:
            raise ValueError("Unexpected checkpoint digest")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Small Git blobs are downloaded again; large LFS files have a pinned digest.
        valid = target.is_file() and target.stat().st_size == entry["size"] and expected_hash and sha256(target) == expected_hash
        if not valid:
            partial = target.with_name(target.name + ".partial")
            try:
                url = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{relative}"
                if entry["size"] > 128 * 1024 * 1024:
                    download_large(url, partial, entry["size"])
                else:
                    request = Request(url, headers={"User-Agent": "digital-memory-embedding-evaluation"})
                    with urlopen(request, timeout=120) as response, partial.open("wb") as output:
                        partial.chmod(0o600)
                        size = 0
                        for chunk in iter(lambda: response.read(1024 * 1024), b""):
                            size += len(chunk)
                            if size > entry["size"]:
                                raise ValueError("Unexpected file size")
                            output.write(chunk)
                if partial.stat().st_size != entry["size"] or expected_hash and sha256(partial) != expected_hash:
                    raise ValueError("Checkpoint verification failed")
                partial.replace(target)
            except Exception as error:
                # Redirect URLs may carry temporary signatures; do not print them.
                raise RuntimeError(f"Download failed: {relative} ({type(error).__name__})") from None
            finally:
                partial.unlink(missing_ok=True)
        print(json.dumps({"file": relative, "status": "verified", "bytes": entry["size"]}), flush=True)
        return {"path": relative, "bytes": entry["size"], "sha256": sha256(target)}

    entries = [entry for entry in repository["siblings"] if entry["rfilename"] != ".gitattributes"]
    with ThreadPoolExecutor(max_workers=3) as pool:
        files = list(pool.map(download, entries))
    (root / "evaluation-manifest.json").write_text(json.dumps({"model": MODEL, "revision": REVISION, "files": files}, indent=2) + "\n")
    print(json.dumps({"status": "ready", "model": MODEL, "revision": REVISION}), flush=True)


if __name__ == "__main__":
    main()
