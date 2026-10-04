"""Local, fixed-purpose feature worker. JSON lines in/out; no runtime networking."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import re
import sys
import warnings
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps
from tokenizers import Tokenizer

from setup_models import digest

MAX_BYTES = 20 * 1024 * 1024
MAX_LINE = 29 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
cv2.setNumThreads(2)


def normalized(values: np.ndarray) -> list[list[float]]:
    values = np.asarray(values, dtype=np.float32)
    if values.ndim == 1:
        values = values[None, :]
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if not np.all(np.isfinite(values)) or np.any(norms < 1e-8):
        raise ValueError("Invalid embedding")
    return (values / norms).tolist()


class Worker:
    def __init__(self, root: Path):
        self.root = root.resolve()
        # Use the versioned source manifest, never an arbitrary model name or code download.
        self.manifest = json.loads(Path(__file__).with_name("models.json").read_text())
        for entry in self.manifest["files"]:
            path = (self.root / entry["path"]).resolve()
            if not path.is_relative_to(self.root) or not path.is_file() or path.stat().st_size != entry["bytes"]:
                raise ValueError("Model not provisioned")
            if digest(path) != entry["sha256"]:
                raise ValueError("Model checksum mismatch")
        encoded = json.dumps(self.manifest, sort_keys=True, separators=(",", ":")).encode()
        self.fingerprint = hashlib.sha256(encoded).hexdigest()
        self.sessions: dict[str, ort.InferenceSession] = {}
        self.tokenizers: dict[str, Tokenizer] = {}
        self.detector = None
        self.recognizer = None

    def info(self) -> dict:
        return {"protocol": 1, "processorVersion": self.manifest["processorVersion"],
                "fingerprint": self.fingerprint, "device": "cpu", "network": False,
                "encoders": self.manifest["encoders"]}

    def session(self, key: str) -> ort.InferenceSession:
        if key not in self.sessions:
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.log_severity_level = 3
            paths = {"text": "e5/model.onnx", "image_text": "siglip/text.onnx", "image": "siglip/image.onnx"}
            self.sessions[key] = ort.InferenceSession(str(self.root / paths[key]), options, providers=["CPUExecutionProvider"])
        return self.sessions[key]

    def tokenizer(self, key: str) -> Tokenizer:
        if key not in self.tokenizers:
            folder = "e5" if key == "text" else "siglip"
            tokenizer = Tokenizer.from_file(str(self.root / folder / "tokenizer.json"))
            config = json.loads((self.root / folder / "tokenizer_config.json").read_text())
            maximum = 512 if key == "text" else 64
            tokenizer.enable_truncation(max_length=maximum)
            tokenizer.enable_padding(pad_id=tokenizer.token_to_id(config["pad_token"]),
                                     pad_token=config["pad_token"], length=None if key == "text" else maximum)
            self.tokenizers[key] = tokenizer
        return self.tokenizers[key]

    def embed(self, request: dict) -> dict:
        key = request.get("encoder", "text")
        texts = request.get("texts")
        if key not in ("text", "image_text") or not isinstance(texts, list) or not 1 <= len(texts) <= 16:
            raise ValueError("Invalid batch")
        if any(not isinstance(text, str) or not text.strip() or len(text) > 8192 for text in texts):
            raise ValueError("Invalid text")
        if key == "text":
            role = request.get("role", "passage")
            if role not in ("query", "passage"):
                raise ValueError("Invalid role")
            texts = [role + ": " + text for text in texts]
        else:
            texts = [text.lower() for text in texts]
        encodings = self.tokenizer(key).encode_batch(texts)
        inputs = {"input_ids": np.array([item.ids for item in encodings], dtype=np.int64),
                  "attention_mask": np.array([item.attention_mask for item in encodings], dtype=np.int64),
                  "token_type_ids": np.array([item.type_ids for item in encodings], dtype=np.int64)}
        session = self.session(key)
        outputs = dict(zip([item.name for item in session.get_outputs()],
                           session.run(None, {item.name: inputs[item.name] for item in session.get_inputs()})))
        if key == "text":
            hidden = outputs["last_hidden_state"]
            mask = inputs["attention_mask"][..., None]
            features = (hidden * mask).sum(axis=1) / mask.sum(axis=1)
        else:
            features = outputs["pooler_output"]
        return {"vectors": normalized(features), "truncated": [bool(item.overflowing) for item in encodings],
                "tokens": [sum(item.attention_mask) for item in encodings], "fingerprint": self.fingerprint}

    def image(self, request: dict) -> dict:
        encoded = request.get("data")
        if not isinstance(encoded, str) or len(encoded) > (MAX_BYTES + 2) * 4 // 3:
            raise ValueError("Invalid image size")
        data = base64.b64decode(encoded, validate=True)
        if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != request.get("sha256"):
            raise ValueError("Image checksum mismatch")
        with Image.open(io.BytesIO(data)) as original:
            if original.format not in ("JPEG", "PNG", "WEBP") or getattr(original, "n_frames", 1) != 1:
                raise ValueError("Unsupported image")
            if original.width * original.height > Image.MAX_IMAGE_PIXELS:
                raise ValueError("Image too large")
            metadata = self.metadata(original)
            rgb = ImageOps.exif_transpose(original).convert("RGB")
        width, height = rgb.size
        # Official SigLIP processor uses PIL BILINEAR (resample=2), rescale 1/255, mean/std .5.
        pixels = np.asarray(rgb.resize((224, 224), Image.Resampling.BILINEAR), dtype=np.float32)
        pixels = ((pixels / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None, ...]
        session = self.session("image")
        outputs = dict(zip([item.name for item in session.get_outputs()], session.run(None, {"pixel_values": pixels})))
        faces = self.faces(rgb)
        return {"vector": normalized(outputs["pooler_output"])[0], "faces": faces,
                "width": width, "height": height, "coordinateSpace": "exif-oriented",
                "metadata": metadata, "fingerprint": self.fingerprint}

    @staticmethod
    def metadata(original: Image.Image) -> dict:
        exif = original.getexif()
        try:
            detail = exif.get_ifd(34665)
        except (ValueError, KeyError, TypeError):
            detail = {}
        value = detail.get(36867, exif.get(36867))
        offset = detail.get(36881, exif.get(36881))
        date = value if isinstance(value, str) and re.fullmatch(r"\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}", value) else None
        zone = offset if isinstance(offset, str) and re.fullmatch(r"[+-]\d{2}:\d{2}", offset) else None
        # Keep observations local. No inferred timezone, location, owner, or event time.
        return {"capturedLocal": date, "offset": zone, "source": "EXIF" if date else None,
                "certainty": "unverified" if date else "unknown", "hasGps": 34853 in exif}

    def faces(self, rgb: Image.Image) -> list[dict]:
        if self.detector is None:
            self.detector = cv2.FaceDetectorYN.create(str(self.root / "faces/detector.onnx"), "", (320, 320), 0.9, 0.3, 5000)
            self.recognizer = cv2.FaceRecognizerSF.create(str(self.root / "faces/recognizer.onnx"), "")
        resized = rgb.copy()
        resized.thumbnail((1600, 1600), Image.Resampling.BILINEAR)
        bgr = cv2.cvtColor(np.asarray(resized), cv2.COLOR_RGB2BGR)
        height, width = bgr.shape[:2]
        # YuNet's training range is roughly 10–300 face pixels. Multiple scales
        # cover both close portraits and smaller faces; SFace uses the larger raster.
        detections = []
        for edge in self.manifest["encoders"]["face"]["detectionScales"]:
            ratio = min(1.0, edge / max(width, height))
            scaled = cv2.resize(bgr, (max(1, round(width * ratio)), max(1, round(height * ratio))), interpolation=cv2.INTER_AREA)
            sy, sx = scaled.shape[:2]
            self.detector.setInputSize((sx, sy))
            _, faces = self.detector.detect(scaled)
            if faces is not None:
                for face in faces:
                    mapped = face.copy()
                    mapped[[0, 2, 4, 6, 8, 10, 12]] *= width / sx
                    mapped[[1, 3, 5, 7, 9, 11, 13]] *= height / sy
                    detections.append(mapped)
        if not detections:
            return []
        keep = cv2.dnn.NMSBoxes([row[:4].tolist() for row in detections], [float(row[-1]) for row in detections], 0.9, 0.3)
        detected = [detections[int(index)] for index in np.asarray(keep).flatten()]
        result = []
        for face in sorted(detected, key=lambda row: (float(row[0]), float(row[1])))[:32]:
            x, y, w, h = (float(value) for value in face[:4])
            left, top, right, bottom = max(0.0, x / width), max(0.0, y / height), min(1.0, (x + w) / width), min(1.0, (y + h) / height)
            if right <= left or bottom <= top:
                continue
            quality = "usable" if min(w, h) >= 32 else "small"
            feature = self.recognizer.feature(self.recognizer.alignCrop(bgr, face)) if quality == "usable" else None
            result.append({"region": {"x": left, "y": top, "width": right - left, "height": bottom - top},
                           "detectionScore": float(face[-1]), "quality": quality,
                           "vector": normalized(feature)[0] if feature is not None else None})
        return result

    def handle(self, request: dict) -> dict:
        action = request.get("action")
        if action == "info":
            return self.info()
        if action == "embed":
            return self.embed(request)
        if action == "image":
            return self.image(request)
        raise ValueError("Unknown action")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    try:
        worker = Worker(args.models)
    except Exception:
        print(json.dumps({"id": None, "error": {"code": "MODELS_UNAVAILABLE"}}), flush=True)
        return
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            return
        if len(line) > MAX_LINE or not line.endswith(b"\n"):
            return
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("id"), str) or len(request["id"]) > 80:
                raise ValueError("Invalid request")
            request_id = request["id"]
            result = worker.handle(request)
            response = {"id": request_id, "result": result}
        except Exception:
            # Inputs, private contents, paths and native exception messages never enter logs.
            response = {"id": request_id, "error": {"code": "PROCESSING_FAILED"}}
        print(json.dumps(response, separators=(",", ":"), allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
