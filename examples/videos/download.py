"""Download the two public original videos and verify their recorded digests."""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
target = root / ".data" / "video-fixtures"
target.mkdir(parents=True, exist_ok=True, mode=0o700)
manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
for video in manifest["videos"]:
    path = target / video["file"]
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == video["sha256"]:
        print(video["id"], "verified existing original")
        continue
    request = Request(video["download"], headers={"User-Agent": "DigitalMemoryVideoEvaluation/1.0"})
    with urlopen(request, timeout=45) as response:
        data = response.read(20 * 1024 * 1024 + 1)
    if len(data) != video["bytes"] or hashlib.sha256(data).hexdigest() != video["sha256"]:
        raise RuntimeError("Original changed: " + video["id"])
    path.write_bytes(data)
    path.chmod(0o600)
    print(video["id"], "downloaded and verified")
