"""Compare real local embeddings on the frozen public/fictitious regression corpus.

This measures encoder ranking, not the product's FTS, eligibility filters, reranker,
face recognition, source verification, or answer generation. Historical holdout
labels are retained for reporting only; this corpus is no longer a blind test.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

# The evaluation uses only local files. Setup/download is a separate command.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_vectors(values, rows: int, dimensions: int) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32).reshape(rows, dimensions)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if not np.isfinite(values).all() or np.any(norms < 1e-8):
        raise ValueError("Non-finite or empty embedding")
    return values / norms


class Legacy:
    dimensions = 384
    image_dimensions = 768

    def __init__(self, model_dir: Path, device: str):
        if device != "cpu":
            raise ValueError("The production baseline is CPU ONNX")
        sys.path.insert(0, str(ROOT / "services/memory-worker"))
        from worker import Worker
        self.worker = Worker(model_dir)
        self.info = self.worker.info()

    def text(self, values: list[str], query=False, image=False):
        result = self.worker.embed({"texts": values, "role": "query" if query else "passage",
                                    "encoder": "image_text" if image else "text"})
        if any(result["truncated"]):
            raise ValueError("Baseline input was truncated")
        return checked_vectors(result["vectors"], len(values), self.image_dimensions if image else self.dimensions)

    def image(self, path: Path):
        # Exactly the pinned worker's SigLIP preprocessing/forward pass. Face
        # detection is outside this benchmark and contributes no fake results.
        with Image.open(path) as source:
            rgb = ImageOps.exif_transpose(source).convert("RGB")
            pixels = np.asarray(rgb.resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32)
        pixels = ((pixels / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None, ...]
        session = self.worker.session("image")
        output = dict(zip([item.name for item in session.get_outputs()], session.run(None, {"pixel_values": pixels})))
        return checked_vectors(output["pooler_output"], 1, self.image_dimensions)

    def resources(self):
        return {}


class Gemma:
    dimensions = image_dimensions = 768

    def __init__(self, model_dir: Path, device: str):
        manifest = json.loads((model_dir / "evaluation-manifest.json").read_text())
        if manifest["model"] != "google/embeddinggemma-2" or manifest["revision"] != REVISION:
            raise ValueError("Unexpected evaluation model")
        for entry in manifest["files"]:
            path = (model_dir / entry["path"]).resolve()
            if not path.is_relative_to(model_dir.resolve()) or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
                raise ValueError("Checkpoint checksum mismatch")
        import torch
        from sentence_transformers import SentenceTransformer
        self.torch = torch
        self.device = device
        torch.set_num_threads(2)
        if device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA is not available")
        dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
        if device == "cuda":
            torch.cuda.reset_peak_memory_stats()
        self.model = SentenceTransformer(str(model_dir), device=device,
                                        config_kwargs={"audio_config": None},
                                        model_kwargs={"torch_dtype": dtype},
                                        local_files_only=True, trust_remote_code=False)
        self.model.eval()
        self.info = {"model": manifest["model"], "revision": REVISION, "device": device,
                     "dtype": str(dtype), "audio": False, "dimensions": 768,
                     "parameters": sum(p.numel() for p in self.model.parameters()),
                     "gpu": torch.cuda.get_device_name() if device == "cuda" else None,
                     "queryPrompt": "SearchQuery", "documentPrompt": "Document",
                     "modelFiles": manifest["files"]}

    def encode(self, values, **kwargs):
        with self.torch.inference_mode():
            result = self.model.encode(values, batch_size=1, normalize_embeddings=True,
                                       show_progress_bar=False, convert_to_numpy=True, **kwargs)
        if self.device == "cuda":
            self.torch.cuda.synchronize()
        return checked_vectors(result, len(values), self.dimensions)

    def text(self, values: list[str], query=False, image=False):
        # One query representation is shared by text and image search.
        prompt = "SearchQuery" if query else "Document"
        prefix = self.model.prompts[prompt]
        lengths = [len(self.model.tokenizer.encode(prefix + value)) for value in values]
        if max(lengths) > self.model.max_seq_length:
            raise ValueError("Candidate input would be truncated")
        return self.encode(values, prompt_name=prompt)

    def image(self, path: Path):
        with Image.open(path) as source:
            rgb = ImageOps.exif_transpose(source).convert("RGB")
        return self.encode([{"image": rgb}])

    def resources(self):
        if self.device != "cuda":
            return {}
        return {"cudaPeakAllocatedMiB": self.torch.cuda.max_memory_allocated() / 2**20,
                "cudaPeakReservedMiB": self.torch.cuda.max_memory_reserved() / 2**20}


def ranked(queries: list[dict], query_vectors: np.ndarray, ids: list[str], vectors: np.ndarray) -> list[dict]:
    scores = query_vectors @ vectors.T
    rows = []
    for query, similarities in zip(queries, scores):
        order = np.argsort(-similarities, kind="stable")
        ranked_ids = [ids[index] for index in order]
        expected = query["expected"]
        ranks = sorted(ranked_ids.index(key) + 1 for key in expected)
        first = ranks[0] if ranks else None
        rows.append({"id": query["id"], "query": query["query"], "split": query["split"],
                     "expected": expected, "rank": first,
                     "hitAt1": first == 1 if expected else None,
                     "hitAt3": first <= 3 if first else None,
                     "recallAt3": sum(rank <= 3 for rank in ranks) / len(expected) if expected else None,
                     "top5": [{"id": ids[index], "score": float(similarities[index])} for index in order[:5]]})
    return rows


def metrics(rows: list[dict]) -> dict:
    scored = [row for row in rows if row["expected"]]
    return {"queries": len(rows), "scored": len(scored), "unscored": len(rows) - len(scored),
            "hitAt1": sum(row["hitAt1"] for row in scored),
            "hitAt3": sum(row["hitAt3"] for row in scored),
            "mrr": float(np.mean([1 / row["rank"] for row in scored])) if scored else None}


def timing(values: list[float]) -> dict:
    return {"count": len(values), "medianMs": float(np.median(values)), "p95Ms": float(np.percentile(values, 95)),
            "totalMs": sum(values), "samplesMs": values}


def video_smoke(backend, directory: Path) -> dict:
    source_path = ROOT / "examples/videos/manifest.json"
    query_path = ROOT / "examples/quality/embedding-video-queries.json"
    sources = json.loads(source_path.read_text())
    fixture = json.loads(query_path.read_text())
    frames, vectors, durations = [], [], []
    for video in sources["videos"]:
        source = (ROOT / ".data/video-fixtures" / video["file"]).resolve()
        if not source.is_relative_to((ROOT / ".data/video-fixtures").resolve()) or digest(source) != video["sha256"]:
            raise ValueError("Video source checksum mismatch")
        for timestamp in fixture["timestamps"]:
            frame_id = f"{video['id']}-{timestamp}"
            output = directory / f"{frame_id}.jpg"
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(timestamp), "-i", str(source),
                            "-frames:v", "1", "-q:v", "2", str(output)], check=True, capture_output=True)
            start = time.perf_counter()
            vectors.append(backend.image(output))
            durations.append((time.perf_counter() - start) * 1000)
            frames.append({"id": frame_id, "video": video["id"], "requestedTimestamp": timestamp,
                           "sha256": digest(output), "sourceSha256": video["sha256"]})
            print(json.dumps({"stage": "video-frame", "id": frame_id}), flush=True)
    queries = [{**q, "expected": [f["id"] for f in frames if f["video"] == q["video"]]} for q in fixture["queries"]]
    query_vectors = np.concatenate([backend.text([q["query"]], query=True, image=True) for q in queries])
    frame_vectors = np.concatenate(vectors)
    rows = ranked(queries, query_vectors, [f["id"] for f in frames], frame_vectors)
    np.savez_compressed(directory / "video-vectors.npz", frames=frame_vectors, queries=query_vectors)
    return {"scope": "Six sampled frames from two public videos; four scene queries. Image encoder only, no temporal/audio model or production timestamp integration.",
            "sources": sources, "inputHashes": {str(p.relative_to(ROOT)): digest(p) for p in (source_path, query_path)},
            "frames": frames, "rows": rows, "summary": metrics(rows), "frameTiming": timing(durations)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["legacy", "embeddinggemma2"], required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--video-only", action="store_true", help="Only run the small public-video frame smoke check")
    args = parser.parse_args()
    output_root = ROOT / ".data/evaluations"
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = Path(tempfile.mkdtemp(prefix=f"embedding-{args.backend}-{args.device}-", dir=output_root))
    text_path = ROOT / "examples/quality/retrieval.json"
    image_path = ROOT / "examples/quality/images.json"
    texts = json.loads(text_path.read_text())
    photos = json.loads(image_path.read_text())
    image_files = [ROOT / ".data/quality-fixtures" / item["file"] for item in photos["images"]]
    for item, path in zip(photos["images"], image_files):
        if not path.resolve().is_relative_to((ROOT / ".data/quality-fixtures").resolve()) or path.stat().st_size != item["bytes"] or digest(path) != item["sha256"]:
            raise ValueError("Public image checksum mismatch")
    report = {"backend": args.backend, "device": args.device, "at": datetime.now(timezone.utc).isoformat(),
              "scope": "Real encoders, all 41 fictitious current/corrected records and 18 public images; all candidates available for both historical splits. Encoder-only regression, no filters/FTS/face/reader. Not an independent holdout or a product integration test.",
              "completed": False, "platform": platform.platform(),
              "inputs": {str(path.relative_to(ROOT)): digest(path) for path in [text_path, image_path]},
              "implementation": {str(path.relative_to(ROOT)): digest(path) for path in [Path(__file__), ROOT / "services/memory-worker/worker.py", ROOT / "services/memory-worker/models.json"]},
              "packages": {dist.metadata["Name"]: dist.version for dist in importlib.metadata.distributions()}}

    def save():
        (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    save()
    print(json.dumps({"stage": "start", "report": str(directory / "report.json")}), flush=True)
    try:
        start = time.perf_counter()
        backend = (Legacy if args.backend == "legacy" else Gemma)(args.models.resolve(), args.device)
        report["loadMs"] = (time.perf_counter() - start) * 1000
        report["model"] = backend.info
        save()
        print(json.dumps({"stage": "loaded", "loadMs": report["loadMs"]}), flush=True)
        if args.video_only:
            report["scope"] = "Public-video image-encoder smoke check only; not a product integration or temporal-understanding evaluation."
            report["video"] = video_smoke(backend, directory)
            report["resources"] = {"processPeakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
                                   **backend.resources()}
            report["completed"] = True
            save()
            print(json.dumps({"report": str(directory / "report.json"), "video": report["video"]["summary"]}), flush=True)
            return
        # Warm up both towers, separately from query timing. No reference labels
        # or source-page descriptions are passed to either model.
        backend.text(["查找一段记录"], query=True)
        if args.backend == "legacy":
            backend.text(["查找一张图片"], query=True, image=True)
        backend.image(image_files[0])
        people = {person["id"]: person["name"] for person in texts["people"]}
        documents = ["\n".join([item["title"], item.get("correction", item["content"]),
                                *[people[key] for key in item.get("people", [])]]) for item in texts["records"]]
        start = time.perf_counter()
        text_vectors = np.concatenate([backend.text(documents[index:index + 8]) for index in range(0, len(documents), 8)])
        report["textIndexMs"] = (time.perf_counter() - start) * 1000
        print(json.dumps({"stage": "text-index", "count": len(documents)}), flush=True)
        image_vectors, image_times = [], []
        for item, path in zip(photos["images"], image_files):
            start = time.perf_counter()
            image_vectors.append(backend.image(path))
            image_times.append((time.perf_counter() - start) * 1000)
            print(json.dumps({"stage": "image-index", "id": item["id"], "ms": image_times[-1]}), flush=True)
        image_vectors = np.concatenate(image_vectors)
        report["imageIndexTiming"] = timing(image_times)
        query_arrays, times = {}, {}
        for name, queries in [("text", texts["queries"]), ("image", photos["queries"])]:
            vectors, durations = [], []
            for query in queries:
                start = time.perf_counter()
                vectors.append(backend.text([query["query"]], query=True, image=name == "image"))
                durations.append((time.perf_counter() - start) * 1000)
            query_arrays[name] = np.concatenate(vectors)
            times[name] = timing(durations)
        report["queryTiming"] = times
        text_ids = [item["id"] for item in texts["records"]]
        image_ids = [item["id"] for item in photos["images"]]
        report["text"] = ranked(texts["queries"], query_arrays["text"], text_ids, text_vectors)
        report["image"] = ranked(photos["queries"], query_arrays["image"], image_ids, image_vectors)
        if args.backend == "embeddinggemma2":
            report["mixed"] = ranked(texts["queries"] + photos["queries"],
                                     np.concatenate([query_arrays["text"], query_arrays["image"]]),
                                     text_ids + image_ids, np.concatenate([text_vectors, image_vectors]))
        report["summary"] = {channel: {"all": metrics(report[channel]),
                                       **{split: metrics([r for r in report[channel] if r["split"] == split])
                                          for split in ("development", "holdout")}}
                             for channel in ("text", "image", "mixed") if channel in report}
        report["resources"] = {"processPeakRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
                               **backend.resources()}
        np.savez_compressed(directory / "vectors.npz", text=text_vectors, image=image_vectors,
                            text_queries=query_arrays["text"], image_queries=query_arrays["image"])
        report["completed"] = True
        save()
        print(json.dumps({"report": str(directory / "report.json"), "summary": report["summary"],
                          "resources": report["resources"]}, ensure_ascii=False), flush=True)
    except Exception as error:
        report["errorType"] = type(error).__name__
        save()
        raise


if __name__ == "__main__":
    main()
