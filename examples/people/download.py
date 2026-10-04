"""Download licensed public portraits for isolated association evaluation."""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
target = root / ".data" / "people-fixtures"
target.mkdir(parents=True, exist_ok=True, mode=0o700)
manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
for item in manifest["images"]:
    path = target / item["file"]
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]:
        print(item["file"], "verified existing fixture")
        continue
    request = Request(item["download"], headers={"User-Agent": "DigitalMemoryAssociationTest/1.0"})
    with urlopen(request, timeout=45) as response:
        data = response.read(20 * 1024 * 1024 + 1)
    if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise RuntimeError("Public fixture checksum mismatch: " + item["file"])
    temporary = path.with_suffix(".partial")
    temporary.write_bytes(data)
    temporary.chmod(0o600)
    temporary.replace(path)
    print(item["file"], "downloaded and verified")
