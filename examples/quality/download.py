"""Download the pinned licensed images, resuming safely after a host backoff."""
import datetime
import argparse
import hashlib
import json
import time
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--manifest", default=str(Path(__file__).with_name("images.json")))
parser.add_argument("--directory", default=str(root / ".data" / "quality-fixtures"))
args = parser.parse_args()
target = Path(args.directory)
target.mkdir(parents=True, exist_ok=True, mode=0o700)
backoff = target / ".download-backoff.json"
manifest = json.loads(Path(args.manifest).read_text())
if backoff.exists():
    until = datetime.datetime.fromisoformat(json.loads(backoff.read_text())["until"])
    if datetime.datetime.now(datetime.timezone.utc) < until:
        raise SystemExit("下载站点要求等待至 " + until.isoformat())

items = manifest["images"] if "images" in manifest else [manifest["photo"]]
for item in items:
    if Path(item["file"]).name != item["file"]:
        raise ValueError("Invalid fixture filename")
    path = target / item["file"]
    if path.exists():
        data = path.read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Existing fixture changed: " + item["id"])
        print(item["id"], "已核对")
        continue
    request = Request(item["download"], headers={"User-Agent": "DigitalMemoryAgentEvaluation/0.1 (licensed public fixtures; sequential downloads)"})
    try:
        with urlopen(request, timeout=45) as response:
            data = response.read(20 * 1024 * 1024 + 1)
    except HTTPError as error:
        if error.code != 429:
            raise
        retry = error.headers.get("Retry-After", "600")
        try:
            until = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=max(1, int(retry)))
        except ValueError:
            until = parsedate_to_datetime(retry)
        backoff.write_text(json.dumps({"until": until.isoformat(), "reason": "HTTP 429"}) + "\n")
        # Stop the whole host, not just this file; a later invocation resumes.
        raise SystemExit("下载站点要求等待至 " + until.isoformat()) from None
    if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
        raise ValueError("Public fixture checksum mismatch: " + item["id"])
    temporary = path.with_suffix(".partial")
    temporary.write_bytes(data)
    temporary.chmod(0o600)
    temporary.replace(path)
    print(item["id"], "已下载并核对")
    time.sleep(3)
