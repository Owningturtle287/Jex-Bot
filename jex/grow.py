"""Expand a checkpoint while preserving its initial predictions."""

import argparse
from dataclasses import asdict
import json
from pathlib import Path

import torch

from .model import Config, Jex
from .train import save


def grow(state, cfg):
    old = Config(**state["config"])
    factor = cfg.width // old.width
    if (factor < 1 or cfg.width != old.width * factor or cfg.heads != old.heads * factor
            or cfg.hidden != old.hidden * factor or cfg.layers < old.layers
            or cfg.vocab_size != old.vocab_size or cfg.context < old.context):
        raise ValueError("Use a whole-number width expansion, matching heads and hidden size, and equal or greater depth")
    model = Jex(cfg)
    weights = model.state_dict()
    for name, values in state["model"].items():
        if name == "embed.weight":
            expanded = values.repeat(1, factor)
        elif name == "norm.weight":
            expanded = values.repeat(factor) / factor
        elif values.ndim == 1:
            expanded = values.repeat(factor)
        elif name.endswith("qkv.weight"):
            expanded = values.reshape(3, old.width, old.width).repeat(1, factor, factor)
            expanded = expanded.reshape(3 * cfg.width, cfg.width) / factor
        else:
            expanded = values.repeat(factor, factor) / factor
        weights[name] = expanded
    for index in range(old.layers, cfg.layers):
        # Each extra residual block starts as the identity.
        weights[f"blocks.{index}.attn_out.weight"].zero_()
        weights[f"blocks.{index}.down.weight"].zero_()
    model.load_state_dict(weights)
    return {**state, "config": asdict(cfg), "model": model.state_dict(), "step": 0, "tokens": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    state = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    grown = grow(state, Config(**json.loads(args.config.read_text())))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    save(args.out, grown)
    print(f"Expanded {sum(t.numel() for t in state['model'].values()):,} to "
          f"{sum(t.numel() for t in grown['model'].values()):,} parameters")


if __name__ == "__main__":
    main()
