"""Export a trained checkpoint to the browser runtime's int8 format."""

import argparse
from hashlib import sha256
import json
from pathlib import Path

import numpy as np
import torch

from .train import digest
from .tokenizer import PATTERN, SPECIAL


def byte_alphabet():
    visible = [*range(33, 127), *range(161, 173), *range(174, 256)]
    extra = [byte for byte in range(256) if byte not in visible]
    chars = [*visible, *range(256, 256 + len(extra))]
    return {chr(char): byte for char, byte in zip(chars, visible + extra)}


def tokenizer_spec(path):
    tokenizer = json.loads(path.read_text())["model"]
    vocab = tokenizer["vocab"]
    alphabet = byte_alphabet()
    pieces = [[] for _ in vocab]
    for token, index in vocab.items():
        if token not in SPECIAL:
            pieces[index] = [alphabet[char] for char in token]
    merges = []
    for left, right in tokenizer["merges"]:
        merges.append([vocab[left], vocab[right], vocab[left + right]])
    return {"pattern": PATTERN, "pieces": pieces, "merges": merges}


def export(checkpoint, tokenizer, out):
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if state["phase"] != "chat" or state["step"] <= 0:
        raise ValueError("Expected a trained chat checkpoint")
    if state["tokenizer_sha256"] != digest(tokenizer):
        raise ValueError("Tokenizer does not match the checkpoint")
    out.mkdir(parents=True, exist_ok=True)
    weights = bytearray()
    tensors = {}
    for name, tensor in state["model"].items():
        weights.extend(bytes((-len(weights)) % 4))
        offset = len(weights)
        values = tensor.float().numpy()
        if values.ndim == 1:
            weights.extend(values.astype("<f4").tobytes())
        else:
            scale = np.maximum(np.max(np.abs(values), axis=1) / 127, 1e-12)
            quant = np.rint(values / scale[:, None]).clip(-127, 127).astype("i1")
            weights.extend(scale.astype("<f4").tobytes())
            weights.extend(quant.tobytes())
        tensors[name] = {"offset": offset, "shape": list(values.shape)}
    sha = sha256(weights).hexdigest()
    names = []
    # Small immutable shards allow parallel transfers and straightforward hosting.
    for index, start in enumerate(range(0, len(weights), 192 * 1024)):
        name = f"jex-{sha[:12]}-{index}.bin"
        (out / name).write_bytes(weights[start:start + 192 * 1024])
        names.append(name)
    spec = {"format": 1, "name": "Jex Pilot", "config": state["config"],
            "checkpoint_step": state["step"], "weights": names, "sha256": sha,
            "tokenizer_sha256": state["tokenizer_sha256"],
            "bytes": len(weights), "tensors": tensors, "tokenizer": tokenizer_spec(tokenizer)}
    (out / "model.json").write_text(json.dumps(spec, separators=(",", ":")) + "\n")
    print(f"Exported {sum(t.numel() for t in state['model'].values()):,} parameters to {len(weights):,} bytes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    export(args.checkpoint, args.tokenizer, args.out)


if __name__ == "__main__":
    main()
