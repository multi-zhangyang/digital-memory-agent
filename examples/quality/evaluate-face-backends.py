"""Real, offline face comparison. No user store, network, or identity confirmation."""
from __future__ import annotations

import argparse
from collections import Counter
import ctypes
import hashlib
import importlib.metadata
import itertools
import json
import os
from pathlib import Path
import resource
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import warnings

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parents[2]
cv2.setNumThreads(2)


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked(root: Path, entry: dict) -> Path:
    path = (root / entry["path"]).resolve()
    if not path.is_relative_to(root.resolve()) or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
        raise ValueError("Pinned file checksum mismatch: " + entry["path"])
    return path


def gpu_memory() -> int | None:
    try:
        output = subprocess.check_output([
            "nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits", "--id=0",
        ], text=True, timeout=5)
        return int(output.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def preload_cuda() -> None:
    # Use the CUDA 12 wheels pinned in this environment; never silently use CPU.
    site = Path(importlib.metadata.distribution("nvidia-cublas-cu12").locate_file(""))
    for library in ["nvidia/cublas/lib/libcublasLt.so.12", "nvidia/cublas/lib/libcublas.so.12"]:
        ctypes.CDLL(str(site / library), mode=ctypes.RTLD_GLOBAL)
    ort.preload_dlls(directory="")
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("CUDA execution provider unavailable")


class Candidate:
    def __init__(self, args, directory: Path):
        manifest = json.loads((ROOT / "examples/quality/face-models.json").read_text())
        for entry in manifest["files"]:
            checked(args.models, entry)
        sys.path.insert(0, str(args.models / "upstream"))
        from insightface.model_zoo.scrfd import SCRFD
        from insightface.model_zoo.arcface_onnx import ArcFaceONNX
        from insightface.utils.face_align import norm_crop
        # Keep the pinned upstream implementation; this known compatibility
        # notice is recorded in the evaluation documentation, outside timings.
        warnings.filterwarnings("ignore", message=r"`estimate` is deprecated", category=FutureWarning,
                                module=r"insightface\.utils\.face_align")
        self.align = norm_crop
        if args.device == "cuda":
            preload_cuda()
        self.sessions = {}
        for name, filename in [("detector", args.backend + ".onnx"), ("recognizer", "arcface-r50.onnx")]:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.log_severity_level = 3
            options.enable_profiling = True
            options.profile_file_prefix = str(directory / name)
            providers = [("CUDAExecutionProvider", {
                "device_id": 0, "arena_extend_strategy": "kSameAsRequested",
                "cudnn_conv_algo_search": "HEURISTIC", "cudnn_conv_use_max_workspace": "0",
                "gpu_mem_limit": 1024 * 1024 * 1024,
            }), "CPUExecutionProvider"] if args.device == "cuda" else ["CPUExecutionProvider"]
            session = ort.InferenceSession(str(args.models / filename), options, providers=providers)
            session.disable_fallback()
            if args.device == "cuda" and session.get_providers()[0] != "CUDAExecutionProvider":
                raise RuntimeError("CUDA initialization failed; refusing CPU fallback")
            self.sessions[name] = session
        self.detector = SCRFD(str(args.models / (args.backend + ".onnx")), self.sessions["detector"])
        self.detector.prepare(0, input_size=(args.det_size, args.det_size), det_thresh=0.5, nms_thresh=0.4)
        if not self.detector.use_kps:
            raise ValueError("Detector must provide five alignment landmarks")
        self.recognizer = ArcFaceONNX(str(args.models / "arcface-r50.onnx"), self.sessions["recognizer"])
        self.info = {"manifestHash": digest(ROOT / "examples/quality/face-models.json"),
                     "recognizer": "ResNet50@WebFace600K", "dimensions": 512,
                     "detectorThreshold": 0.5, "nmsThreshold": 0.4, "detSize": args.det_size,
                     "providers": {name: session.get_providers() for name, session in self.sessions.items()},
                     "providerOptions": {name: session.get_provider_options() for name, session in self.sessions.items()}}

    def faces(self, rgb: Image.Image) -> list[dict]:
        rgb = rgb.copy()
        rgb.thumbnail((1600, 1600), Image.Resampling.BILINEAR)
        bgr = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
        height, width = bgr.shape[:2]
        boxes, points = self.detector.detect(bgr)
        result = []
        for index in sorted(range(len(boxes)), key=lambda i: tuple(boxes[i, :2]))[:32]:
            x1, y1, x2, y2, score = (float(x) for x in boxes[index])
            left, top, right, bottom = max(0., x1 / width), max(0., y1 / height), min(1., x2 / width), min(1., y2 / height)
            if right <= left or bottom <= top:
                continue
            usable = min(x2 - x1, y2 - y1) >= 32
            vector = None
            if usable:
                aligned = self.align(bgr, points[index], image_size=self.recognizer.input_size[0])
                feature = self.recognizer.get_feat(aligned).flatten().astype(np.float32)
                norm = np.linalg.norm(feature)
                if feature.shape != (512,) or not np.all(np.isfinite(feature)) or norm < 1e-8:
                    raise ValueError("Invalid face embedding")
                vector = (feature / norm).tolist()
            result.append({"region": {"x": left, "y": top, "width": right-left, "height": bottom-top},
                           "detectionScore": score, "quality": "usable" if usable else "small", "vector": vector})
        return result

    def finish_profile(self, device: str) -> dict:
        profiles = {}
        for name, session in self.sessions.items():
            path = session.end_profiling()
            events = json.loads(Path(path).read_text())
            kernels = [e for e in events if e.get("cat") == "Node" and e.get("args", {}).get("provider")]
            counts = Counter(e["args"]["provider"] for e in kernels)
            operations = Counter((e["args"]["provider"], e["args"].get("op_name")) for e in kernels)
            if device == "cuda" and not counts["CUDAExecutionProvider"]:
                raise RuntimeError("No actual CUDA kernels recorded for " + name)
            compute_ops = {"Conv", "FusedConv", "NhwcConv", "Gemm", "MatMul", "FusedMatMul"}
            if device == "cuda" and (not any(p == "CUDAExecutionProvider" and op in compute_ops for p, op in operations)
                                     or any(p != "CUDAExecutionProvider" and op in compute_ops for p, op in operations)):
                raise RuntimeError("Core neural-network computation is not entirely on CUDA: " + name)
            profiles[name] = {"path": path, "nodeExecutions": dict(counts),
                              "operations": [{"provider": p, "op": op, "count": n} for (p, op), n in operations.items()]}
        return profiles


def transformed(image: Image.Image, variant: str) -> Image.Image:
    image = image.copy()
    image.thumbnail((1600, 1600), Image.Resampling.BILINEAR)
    if "small" in variant:
        image.thumbnail((160, 160), Image.Resampling.LANCZOS)
    if "dark" in variant:
        image = ImageEnhance.Brightness(image).enhance(0.25)
    return image


def vector_of(faces: list[dict]):
    # Do not guess the correct identity when detection is absent or ambiguous.
    return np.asarray(faces[0]["vector"]) if len(faces) == 1 and faces[0]["vector"] is not None else None


def pair_scores(portraits: list[dict], outputs: dict) -> list[dict]:
    result = []
    for a, b in itertools.combinations(portraits, 2):
        va, vb = vector_of(outputs[a["id"]]), vector_of(outputs[b["id"]])
        result.append({"a": a["id"], "b": b["id"], "same": a["faceGroups"] == b["faceGroups"],
                       "split": "development" if a["split"] == b["split"] == "development" else "historical-holdout",
                       "similarity": float(va @ vb) if va is not None and vb is not None else None})
    return result


def score_pairs(pairs: list[dict], threshold: float) -> dict:
    available = [p for p in pairs if p["similarity"] is not None]
    positives = [p["similarity"] for p in available if p["same"]]
    negatives = [p["similarity"] for p in available if not p["same"]]
    return {"threshold": threshold, "total": len(pairs), "missing": len(pairs)-len(available),
            "samePairs": sum(p["same"] for p in pairs), "differentPairs": sum(not p["same"] for p in pairs),
            "trueAccepts": sum(s >= threshold for s in positives), "falseRejects": sum(s < threshold for s in positives),
            "trueRejects": sum(s < threshold for s in negatives), "falseAccepts": sum(s >= threshold for s in negatives),
            "minSame": min(positives, default=None), "maxDifferent": max(negatives, default=None)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["legacy", "scrfd-2.5g", "scrfd-10g"], required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--models", type=Path, default=ROOT / ".data/memory-worker/insightface-eval")
    parser.add_argument("--det-size", type=int, choices=[640, 960], default=640)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if args.repeats < 1 or args.repeats > 20 or (args.backend == "legacy" and args.device != "cpu"):
        parser.error("Use 1–20 repeats; legacy backend is CPU only")
    os.umask(0o077)
    directory = Path(tempfile.mkdtemp(prefix=f"face-{args.backend}-{args.device}-", dir=ROOT / ".data/evaluations"))
    manifest_path = ROOT / "examples/quality/images.json"
    manifest = json.loads(manifest_path.read_text())
    report = {"type": "real-offline-face-comparison", "completed": False, "backend": args.backend,
              "device": args.device, "fixtureManifestHash": digest(manifest_path),
              "implementationHash": digest(Path(__file__)), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "network": False, "userStoreModified": False, "repeats": args.repeats,
              "scope": "Historical public regression; transformed images are NOT independent photos. No production threshold calibration.",
              "timingScope": "Warm image-to-face pipeline, including resize/alignment/embedding; excludes file decode and model loading; serial calls.",
              "versions": {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()}, "images": [], "stress": []}
    save = lambda: (directory / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    samples = []
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            value = gpu_memory()
            if value is not None:
                samples.append(value)
            stop.wait(0.2)
    report["gpuMemoryBeforeMiB"] = gpu_memory() if args.device == "cuda" else None
    monitor = threading.Thread(target=sample, daemon=True)
    if args.device == "cuda":
        monitor.start()
    try:
        start = time.perf_counter()
        if args.backend == "legacy":
            sys.path.insert(0, str(ROOT / "services/memory-worker"))
            from worker import Worker
            backend = Worker(ROOT / ".data/memory-worker/models")
            report["processor"] = backend.info()
        else:
            backend = Candidate(args, directory)
            report["processor"] = backend.info
        report["loadMs"] = (time.perf_counter()-start)*1000
        originals = {}
        for item in manifest["images"]:
            path = checked(ROOT / ".data/quality-fixtures", {**item, "path": item["file"]})
            with Image.open(path) as image:
                originals[item["id"]] = ImageOps.exif_transpose(image).convert("RGB")
        for _ in range(3):
            backend.faces(originals["person-a-1"])
        if args.backend != "legacy":
            report["executionProfile"] = backend.finish_profile(args.device)
        outputs, vectors = {}, {}
        variants = ["original", "small", "dark", "small-dark"]
        portraits = [x for x in manifest["images"] if len(x["faceGroups"]) == 1]
        for variant in variants:
            cases = manifest["images"] if variant == "original" else portraits
            for item in cases:
                # Original is passed intact so each backend's 1600px policy is timed.
                rgb = originals[item["id"]] if variant == "original" else transformed(originals[item["id"]], variant)
                times, faces = [], None
                for _ in range(args.repeats):
                    start = time.perf_counter()
                    faces = backend.faces(rgb)
                    times.append((time.perf_counter()-start)*1000)
                for i, face in enumerate(faces):
                    if face["vector"] is not None:
                        vector = np.asarray(face["vector"], dtype=np.float32)
                        if not np.all(np.isfinite(vector)) or abs(float(np.linalg.norm(vector))-1) > 1e-4:
                            raise ValueError("Nonfinite or unnormalized vector")
                        vectors[f"{variant}:{item['id']}:{i}"] = vector
                key = item["id"] if variant == "original" else variant + ":" + item["id"]
                outputs[key] = faces
                row = {"id": item["id"], "variant": variant, "sourceSha256": item["sha256"],
                       "pixelSha256": hashlib.sha256(rgb.tobytes()).hexdigest(), "size": list(rgb.size),
                       "expectedFaces": item["expectedFaces"], "detectedFaces": len(faces),
                       "usableFaces": sum(f["vector"] is not None for f in faces),
                       "durationMs": times, "medianMs": statistics.median(times),
                       "faces": [{k: v for k, v in f.items() if k != "vector"} for f in faces]}
                report["images" if variant == "original" else "stress"].append(row)
                if variant == "original":
                    preview = rgb.copy()
                    preview.thumbnail((700, 700))
                    draw = ImageDraw.Draw(preview)
                    for face in faces:
                        r = face["region"]
                        box = (r["x"]*preview.width, r["y"]*preview.height,
                               (r["x"]+r["width"])*preview.width, (r["y"]+r["height"])*preview.height)
                        draw.rectangle(box, outline="red", width=2)
                    preview.save(directory / (item["id"] + ".jpg"))
                print(json.dumps({"variant": variant, "id": item["id"], "faces": len(faces), "ms": round(row["medianMs"], 2)}), flush=True)
            save()
        pairs = pair_scores(portraits, outputs)
        dev = [p for p in pairs if p["split"] == "development"]
        same = [p["similarity"] for p in dev if p["same"] and p["similarity"] is not None]
        different = [p["similarity"] for p in dev if not p["same"] and p["similarity"] is not None]
        if len(same) != 2 or len(different) != 8 or min(same) <= max(different):
            raise RuntimeError("Development pairs do not separate; do not invent a passing threshold")
        # Freeze on original development pairs only; no stress or historical holdout tuning.
        threshold = 0.55 if args.backend == "legacy" else (min(same)+max(different))/2
        report["pairs"] = pairs
        report["recognition"] = {"thresholdMethod": "existing 0.55" if args.backend == "legacy" else "midpoint of original development min-positive/max-negative; exploratory only",
                                 "development": score_pairs(dev, threshold),
                                 "historicalHoldout": score_pairs([p for p in pairs if p["split"] != "development"], threshold)}
        probes = []
        for variant in variants[1:]:
            for item in portraits:
                gallery = [x for x in portraits if x["id"] != item["id"]]
                if not any(x["faceGroups"] == item["faceGroups"] for x in gallery):
                    continue
                probe = vector_of(outputs[variant+":"+item["id"]])
                scores = []
                if probe is not None:
                    for ref in gallery:
                        vector = vector_of(outputs[ref["id"]])
                        if vector is not None:
                            scores.append({"id": ref["id"], "group": ref["faceGroups"][0], "score": float(probe@vector)})
                scores.sort(key=lambda x: -x["score"])
                best = scores[0] if scores else None
                # Compare distinct identities, not two photographs of the same person.
                other = next((s for s in scores if s["group"] != best["group"]), None) if best else None
                gap = best["score"]-other["score"] if best and other else None
                accepted = bool(best and best["score"] >= threshold and (gap is None or gap >= 0.1))
                correct = bool(best and best["group"] == item["faceGroups"][0])
                probes.append({"id": item["id"], "variant": variant, "missing": probe is None,
                               "best": best, "gapToOtherIdentity": gap, "top1Correct": correct,
                               "accepted": accepted, "correctAccepted": accepted and correct,
                               "wrongAccepted": accepted and not correct})
        report["stressRecognition"] = probes
        rows = report["images"]
        report["summary"] = {"exactFaceCountImages": sum(r["detectedFaces"] == r["expectedFaces"] for r in rows),
                             "images": len(rows), "objectFalseDetections": sum(r["detectedFaces"] for r in rows if r["expectedFaces"] == 0),
                             "medianImageMs": statistics.median(r["medianMs"] for r in rows),
                             "medianPeopleImageMs": statistics.median(r["medianMs"] for r in rows if r["expectedFaces"] > 0),
                             "stress": {v: {"detected": sum(r["detectedFaces"] == 1 for r in report["stress"] if r["variant"] == v),
                                             "usable": sum(r["usableFaces"] == 1 for r in report["stress"] if r["variant"] == v),
                                             "images": len(portraits), "probes": sum(p["variant"] == v for p in probes),
                                             "top1Correct": sum(p["top1Correct"] for p in probes if p["variant"] == v),
                                             "correctAccepted": sum(p["correctAccepted"] for p in probes if p["variant"] == v),
                                             "wrongAccepted": sum(p["wrongAccepted"] for p in probes if p["variant"] == v)} for v in variants[1:]}}
        np.savez_compressed(directory / "vectors.npz", **vectors)
        report["completed"] = True
    finally:
        stop.set()
        if monitor.is_alive():
            monitor.join(timeout=6)
        report["sampledWholeGpuMaxMiB"] = max(samples, default=None)
        report["gpuMemorySampleCount"] = len(samples)
        report["peakRssMiB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024
        save()
        print(json.dumps({"report": str(directory / "report.json"), "completed": report["completed"], "summary": report.get("summary")}), flush=True)


if __name__ == "__main__":
    main()
