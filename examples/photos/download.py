"""Download only the public evaluation fixtures; verify every original digest."""
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
target = root / ".data" / "photo-fixtures"
target.mkdir(parents=True, exist_ok=True, mode=0o700)
manifest = json.loads(Path(__file__).with_name("manifest.json").read_text())
for photo in manifest["photos"]:
    path = target / photo["file"]
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == photo["sha256"]:
        print(photo["id"], "verified existing fixture")
        continue
    request = Request(photo["download"], headers={"User-Agent": "DigitalMemoryPhotoTest/1.0"})
    with urlopen(request, timeout=45) as response:
        data = response.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != photo["sha256"]:
        raise RuntimeError("Fixture changed: " + photo["id"])
    path.write_bytes(data)
    path.chmod(0o600)
    print(photo["id"], "downloaded and verified")
