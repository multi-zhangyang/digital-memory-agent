"""Download pinned public model data. Never reads or sends personal assets."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import uuid4


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name("models.json").read_text())
    root = args.destination.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def download(entry: dict) -> None:
        target = (root / entry["path"]).resolve()
        if not target.is_relative_to(root):
            raise ValueError("Invalid model path")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.is_file() and target.stat().st_size == entry["bytes"] and digest(target) == entry["sha256"]:
            print(json.dumps({"file": entry["path"], "status": "verified"}), flush=True)
            return
        temporary = target.with_name(target.name + "." + str(uuid4()) + ".partial")
        try:
            request = Request(entry["url"], headers={"User-Agent": "digital-memory-model-setup"})
            size = 0
            with urlopen(request, timeout=120) as response, temporary.open("xb") as output:
                os.chmod(temporary, 0o600)
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    size += len(chunk)
                    if size > entry["bytes"]:
                        raise ValueError("Unexpected model size")
                    output.write(chunk)
            if size != entry["bytes"] or digest(temporary) != entry["sha256"]:
                raise ValueError("Model checksum mismatch")
            temporary.replace(target)
            print(json.dumps({"file": entry["path"], "status": "verified", "bytes": size}), flush=True)
        except Exception as error:
            # Redirect URLs can contain temporary signatures. Do not print exceptions or response bodies.
            raise RuntimeError(f"Model download failed: {entry['path']} ({type(error).__name__})") from None
        finally:
            temporary.unlink(missing_ok=True)

    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, manifest["files"]))
    staged = root / ("manifest." + str(uuid4()) + ".tmp")
    staged.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    os.chmod(staged, 0o600)
    staged.replace(root / "manifest.json")
    print(json.dumps({"status": "ready", "models": list(manifest["encoders"])}))


if __name__ == "__main__":
    main()
