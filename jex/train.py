"""Pretrain or instruction-tune Jex with resumable optimizer state."""

import argparse
from contextlib import nullcontext
from dataclasses import asdict
from hashlib import file_digest
import json
import math
from pathlib import Path
import time

import numpy as np
import torch
from torch.nn import functional as F

from .model import Config, Jex
from .tokenizer import PAD

IGNORE = -100


class PretrainData:
    def __init__(self, path):
        self.tokens = np.memmap(path, dtype="<u2", mode="r")

    def batch(self, rng, batch, length):
        offsets = rng.integers(0, len(self.tokens) - length, size=batch)
        rows = self.tokens[offsets[:, None] + np.arange(length + 1)].astype(np.int64)
        return torch.from_numpy(rows[:, :-1]), torch.from_numpy(rows[:, 1:])


class ChatData:
    def __init__(self, path, jex_weight):
        with path.open() as handle:
            self.rows = [json.loads(line) for line in handle]
        self.jex = np.asarray([index for index, row in enumerate(self.rows) if row[2] == "jex"])
        self.other = np.asarray([index for index, row in enumerate(self.rows) if row[2] != "jex"])
        self.jex_weight = jex_weight

    def batch(self, rng, batch, length):
        if self.jex.size and self.other.size:
            local = rng.random(batch) < self.jex_weight
            indices = rng.choice(self.other, size=batch)
            indices[local] = rng.choice(self.jex, size=int(local.sum()))
        else:
            indices = rng.integers(len(self.rows), size=batch)
        selected = [self.rows[index] for index in indices]
        padded = min(length, (max(len(row[0]) for row in selected) + 6) // 8 * 8)
        x = np.full((batch, padded), PAD, dtype=np.int64)
        y = np.full((batch, padded), IGNORE, dtype=np.int64)
        for index, (ids, targets, _) in enumerate(selected):
            count = len(ids) - 1
            if count > length:
                raise ValueError("Chat example exceeds training sequence length")
            x[index, :count] = ids[:-1]
            y[index, :count] = np.where(targets[1:], ids[1:], IGNORE)
        return torch.from_numpy(x), torch.from_numpy(y)


def loss_sum(model, x, y):
    logits = model(x)
    return F.cross_entropy(logits.flatten(0, 1).float(), y.flatten(), ignore_index=IGNORE, reduction="sum")


def digest(path):
    with path.open("rb") as handle:
        return file_digest(handle, "sha256").hexdigest()


def save(path, value):
    temp = path.with_suffix(".tmp")
    torch.save(value, temp)
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["pretrain", "chat"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--length", type=int)
    parser.add_argument("--accumulate", type=int, default=1)
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--warmup", type=int, default=50)
    parser.add_argument("--eval-every", type=int, default=100)
    parser.add_argument("--eval-batches", type=int, default=8)
    parser.add_argument("--jex-weight", type=float, default=0.5)
    parser.add_argument("--device", default="auto")
    precision = parser.add_mutually_exclusive_group()
    precision.add_argument("--bf16", action="store_true")
    precision.add_argument("--fp16", action="store_true")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=124)
    parser.add_argument("--init-noise", type=float, default=0.0,
                        help="Small matrix perturbation when initializing a tuning phase")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--init", type=Path, help="Use model weights from a previous phase")
    group.add_argument("--resume", action="store_true", help="Resume from OUT/last.pt")
    args = parser.parse_args()
    if args.init_noise and not (args.init or args.resume):
        parser.error("--init-noise requires --init or --resume")
    cfg = Config(**json.loads(args.config.read_text()))
    length = cfg.context if args.length is None else args.length
    if not 0 < length <= cfg.context or min(args.steps, args.batch, args.accumulate,
            args.eval_every, args.eval_batches, args.threads) <= 0:
        parser.error("Invalid training dimensions or step counts")
    if not 0 <= args.jex_weight <= 1 or not (math.isfinite(args.lr) and args.lr > 0) or args.warmup < 0 or not 0 <= args.init_noise <= 0.001:
        parser.error("Invalid training weight or learning rate")
    device = torch.device(("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device)
    if args.fp16 and device.type != "cuda":
        parser.error("--fp16 requires a CUDA device")
    scaler = torch.amp.GradScaler("cuda", enabled=args.fp16)
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    model = Jex(cfg).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=0.1,
                                  fused=device.type == "cuda")
    start, best, tokens = 0, math.inf, 0
    args.out.mkdir(parents=True, exist_ok=True)
    last = args.out / "last.pt"
    if last.exists() and not args.resume:
        parser.error("Output already contains a run. Use --resume or choose a new directory.")
    ext = "bin" if args.phase == "pretrain" else "jsonl"
    files = {name: args.data / f"{name}.{ext}" for name in ("train", "valid")}
    tokenizer_sha = digest(args.data / "tokenizer.json")
    signature = {
        "phase": args.phase, "length": length, "batch": args.batch, "accumulate": args.accumulate,
        "lr": args.lr, "warmup": args.warmup, "steps": args.steps, "seed": args.seed,
        "jex_weight": args.jex_weight, "eval_batches": args.eval_batches, "eval_every": args.eval_every,
        "bf16": args.bf16, "fp16": args.fp16, "init_noise": args.init_noise, "data": {name: digest(path) for name, path in files.items()},
    }
    if args.init or args.resume:
        state = torch.load(last if args.resume else args.init, map_location="cpu", weights_only=True)
        if state["config"] != asdict(cfg) or state["tokenizer_sha256"] != tokenizer_sha:
            parser.error("Checkpoint architecture or tokenizer does not match")
        model.load_state_dict(state["model"])
        if args.init and args.init_noise:
            # Break the symmetry of neurons copied during width expansion.
            with torch.no_grad():
                for parameter in model.parameters():
                    if parameter.ndim == 2:
                        parameter.add_(torch.randn_like(parameter) * args.init_noise)
        if args.resume:
            state["signature"].setdefault("fp16", False)
            state["signature"].setdefault("init_noise", 0.0)
            if state["signature"] != signature:
                parser.error("Resume requires the same training options and data")
            optimizer.load_state_dict(state["optimizer"])
            if args.fp16:
                scaler.load_state_dict(state["scaler"])
            rng.bit_generator.state = state["rng"]
            start, best, tokens = state["step"], state["best"], state["tokens"]
        del state
    data = {
        name: PretrainData(path) if args.phase == "pretrain" else ChatData(path, args.jex_weight)
        for name, path in files.items()
    }

    def autocast():
        if args.bf16 or args.fp16:
            dtype = torch.bfloat16 if args.bf16 else torch.float16
            return torch.autocast(device.type, dtype=dtype)
        return nullcontext()

    @torch.no_grad()
    def validate():
        model.eval()
        validation_rng = np.random.default_rng(args.seed + 1)
        losses, count = [], 0
        for _ in range(args.eval_batches):
            x, y = data["valid"].batch(validation_rng, args.batch, length)
            count += int((y != IGNORE).sum())
            with autocast():
                losses.append(loss_sum(model, x.to(device), y.to(device)))
        model.train()
        return torch.stack(losses).sum().item() / count

    def report(step, training_loss=None):
        nonlocal best
        score = validate()
        if not math.isfinite(score):
            raise RuntimeError("Validation loss became non-finite")
        improved = score < best
        best = min(best, score)
        metrics = {"step": step, "tokens": tokens, "train_loss": training_loss, "valid_loss": score,
                   "seconds": round(time.monotonic() - started, 2)}
        print(json.dumps(metrics), flush=True)
        with (args.out / "metrics.jsonl").open("a") as handle:
            handle.write(json.dumps(metrics) + "\n")
        weights = {"config": asdict(cfg), "tokenizer_sha256": tokenizer_sha, "phase": args.phase,
                   "step": step, "tokens": tokens, "model": model.state_dict()}
        if improved:
            save(args.out / "best.pt", weights)
        save(last, {**weights, "optimizer": optimizer.state_dict(), "rng": rng.bit_generator.state,
                    "signature": signature, "best": best, "scaler": scaler.state_dict()})

    started = time.monotonic()
    print(f"{sum(p.numel() for p in model.parameters()):,} parameters on {device}", flush=True)
    if not args.resume:
        report(0)
    running = 0.0
    measured = 0
    for step in range(start + 1, args.steps + 1):
        decay = (step - args.warmup) / max(1, args.steps - args.warmup)
        ratio = step / args.warmup if step <= args.warmup else 0.1 + 0.9 * (1 + math.cos(math.pi * decay)) / 2
        optimizer.param_groups[0]["lr"] = args.lr * ratio
        optimizer.zero_grad(set_to_none=True)
        batches = [data["train"].batch(rng, args.batch, length) for _ in range(args.accumulate)]
        count = sum(int((y != IGNORE).sum()) for _, y in batches)
        losses = []
        for x, y in batches:
            with autocast():
                loss = loss_sum(model, x.to(device), y.to(device)) / count
            scaler.scale(loss).backward()
            losses.append(loss.detach())
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(optimizer)
        scaler.update()
        tokens += count
        running += torch.stack(losses).sum().item()
        measured += 1
        if step % args.eval_every == 0 or step == args.steps:
            report(step, running / measured)
            running, measured = 0.0, 0


if __name__ == "__main__":
    main()
