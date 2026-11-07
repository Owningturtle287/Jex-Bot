"""Restore trainable weights from a released Jex browser model."""

import argparse
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
import torch

from .train import digest, save


def restore(model_dir, tokenizer):
    spec = json.loads((model_dir / "model.json").read_text())
    if spec["format"] != 1 or spec["tokenizer_sha256"] != digest(tokenizer):
        raise ValueError("Unsupported model format or mismatched tokenizer")
    raw = b"".join((model_dir / name).read_bytes() for name in spec["weights"])
    if len(raw) != spec["bytes"] or sha256(raw).hexdigest() != spec["sha256"]:
        raise ValueError("Model checksum mismatch")
    weights = {}
    for name, entry in spec["tensors"].items():
        shape = entry["shape"]
        rows = shape[0]
        offset = entry["offset"]
        scales = np.frombuffer(raw, "<f4", rows, offset)
        values = scales.copy()
        if len(shape) == 2:
            quantized = np.frombuffer(raw, "i1", rows * shape[1], offset + 4 * rows)
            values = quantized.reshape(shape) * scales[:, None]
        weights[name] = torch.from_numpy(values)
    return {"phase": "chat", "step": spec["checkpoint_step"], "config": spec["config"],
            "tokenizer_sha256": spec["tokenizer_sha256"], "model": weights}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=Path("web/model"))
    parser.add_argument("--tokenizer", type=Path, default=Path("data/pilot-tokenizer.json"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    save(args.out, restore(args.model, args.tokenizer))


if __name__ == "__main__":
    main()
