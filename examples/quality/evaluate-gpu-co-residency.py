"""Keep both candidate encoders resident on GPU; run serial image/face jobs."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def memory():
    return int(subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits", "--id=0"], text=True).strip())


def receive(process, timeout=120):
    # Each request produces exactly one JSON line; diagnostics go to the log.
    if not select.select([process.stdout], [], [], timeout)[0]:
        raise TimeoutError("Face worker did not respond")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("Face worker exited before responding")
    return json.loads(line)


def face_child(directory: Path):
    from PIL import Image, ImageOps
    face = module("face_evaluation", "evaluate-face-backends.py")
    args = argparse.Namespace(models=ROOT / ".data/memory-worker/insightface-eval", backend="scrfd-10g", device="cuda", det_size=640)
    backend = face.Candidate(args, directory)
    with Image.open(ROOT / ".data/quality-fixtures/group-2.jpg") as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    for _ in range(3):
        backend.faces(image)
    profile = backend.finish_profile("cuda")
    print(json.dumps({"ready": True, "processor": backend.info, "executionProfile": profile, "gpuMiB": memory()}), flush=True)
    for line in sys.stdin:
        if line.strip() == "stop":
            return
        start = time.perf_counter()
        faces = backend.faces(image)
        print(json.dumps({"faces": len(faces), "usable": sum(f["vector"] is not None for f in faces),
                          "durationMs": (time.perf_counter()-start)*1000, "gpuMiB": memory()}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--face-child", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.face_child:
        face_child(args.face_child)
        return
    import numpy as np
    directory = Path(tempfile.mkdtemp(prefix="gpu-co-residency-", dir=ROOT / ".data/evaluations"))
    report = {"completed": False, "scope": "Two resident GPU processes, batch=1, serial tasks; not concurrent load testing", "gpuBeforeMiB": memory(), "runs": []}
    process = None
    try:
        embedding = module("embedding_evaluation", "evaluate-embedding-backends.py")
        gemma = embedding.Gemma(ROOT / ".data/memory-worker/embeddinggemma2-eval/model", "cuda")
        reference = gemma.image(ROOT / ".data/quality-fixtures/group-2.jpg")
        query = gemma.text(["几个人站在建筑物前合影"], query=True)
        report["embeddingProcessor"] = gemma.info
        report["gpuWithEmbeddingMiB"] = memory()
        with (directory / "face-stderr.log").open("w") as error_log:
            process = subprocess.Popen([str(ROOT / ".data/memory-worker/face-gpu-venv/bin/python"), str(Path(__file__).resolve()),
                                        "--face-child", str(directory)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=error_log, text=True, bufsize=1)
            report["faceReady"] = receive(process)
            if not report["faceReady"].get("ready"):
                raise RuntimeError("Face model not ready")
            for _ in range(3):
                process.stdin.write("run\n")
                process.stdin.flush()
                face = receive(process)
                start = time.perf_counter()
                vector = gemma.image(ROOT / ".data/quality-fixtures/group-2.jpg")
                ms = (time.perf_counter()-start)*1000
                similarity = float((vector * reference).sum())
                if face["faces"] != 5 or face["usable"] != 5 or similarity < 0.999 or query.shape != (1, 768) or not np.all(np.isfinite(query)):
                    raise RuntimeError("Co-resident output verification failed")
                report["runs"].append({"face": face, "embeddingMs": ms, "embeddingRepeatCosine": similarity, "gpuMiB": memory()})
            process.stdin.write("stop\n")
            process.stdin.flush()
            process.wait(timeout=30)
            if process.returncode:
                raise RuntimeError("Face process failed")
        report["embeddingResources"] = gemma.resources()
        report["completed"] = True
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        (directory / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({"report": str(directory / "report.json"), "completed": report["completed"], "runs": report["runs"]}), flush=True)


if __name__ == "__main__":
    main()
