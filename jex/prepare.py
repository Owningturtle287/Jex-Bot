"""Build reproducible, deduplicated corpora and held-out splits."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import random
import re
import subprocess
import tempfile

import numpy as np
import pyarrow.parquet as pq

from .model import Config
from .sources import CHAT_URLS, PRETRAIN_URLS
from .tokenizer import BOS, END, conversation, load_tokenizer, train_tokenizer


def key(text):
    return sha256(" ".join(text.casefold().split()).encode()).digest()


def split(digest):
    return "valid" if int.from_bytes(digest[:4], "big") % 100 < 5 else "train"


def shards(paths, urls, cache):
    if paths:
        yield from map(Path, paths)
        return
    cache.mkdir(parents=True, exist_ok=True)
    for url in urls:
        file = cache / url.split("/resolve/", 1)[1].split("?", 1)[0].replace("/", "_")
        if not file.exists():
            temporary = file.with_suffix(".part")
            subprocess.run(["curl", "-fL", "--retry", "3", url, "-o", str(temporary)], check=True)
            temporary.replace(file)
        yield file


def records(paths, column, seed):
    for path in paths:
        source = pq.ParquetFile(path)
        groups = list(range(source.num_row_groups))
        random.Random(seed).shuffle(groups)
        for group in groups:
            for batch in source.iter_batches(batch_size=512, row_groups=[group], columns=[column]):
                yield from batch.column(0).to_pylist()


def pretrain(args, dest, cfg):
    documents = {"train": [], "valid": []}
    seen = set()
    chars = 0
    paths = shards(args.input, PRETRAIN_URLS, args.cache / "fineweb")
    for raw in records(paths, "text", args.seed):
        text = raw.strip() if raw else ""
        if len(text) < 200:
            continue
        digest = key(text)
        if digest in seen:
            continue
        seen.add(digest)
        documents[split(digest)].append(text)
        chars += len(text)
        if chars >= args.characters:
            break
    if chars < args.characters:
        raise ValueError(f"Only collected {chars:,} of {args.characters:,} requested characters")
    if not all(documents.values()):
        raise ValueError("Need enough documents for both splits")
    tokenizer = train_tokenizer(documents["train"][:args.tokenizer_docs], cfg.vocab_size)
    if tokenizer.get_vocab_size() != cfg.vocab_size:
        raise ValueError("The corpus is too small for the requested vocabulary")
    tokenizer.save(str(dest / "tokenizer.json"))
    stats = {"characters": chars}
    for name, texts in documents.items():
        size = 0
        with (dest / f"{name}.bin").open("wb") as handle:
            for offset in range(0, len(texts), 256):
                encoded = tokenizer.encode_batch(texts[offset:offset + 256], add_special_tokens=False)
                ids = np.asarray([token for row in encoded for token in (BOS, *row.ids, END)], dtype="<u2")
                ids.tofile(handle)
                size += ids.size
        stats[name] = {"documents": len(texts), "tokens": size}
    return stats


def clean_messages(raw):
    if not isinstance(raw, list):
        return None
    messages = []
    for turn in raw:
        if not isinstance(turn, dict) or not isinstance(turn.get("content"), str):
            return None
        role, text = turn.get("role"), turn["content"].strip()
        if not messages and role == "system":
            continue
        expected = ("user", "assistant")[len(messages) % 2]
        if role != expected or not text:
            return None
        messages.append({"role": role, "content": text})
    return messages if messages and len(messages) % 2 == 0 else None


def chat(args, dest, cfg):
    tokenizer = load_tokenizer(args.tokenizer)
    (dest / "tokenizer.json").write_bytes(args.tokenizer.read_bytes())
    paths = shards(args.input, CHAT_URLS, args.cache / "smoltalk")
    handles = {}
    stats = {name: {"conversations": 0, "tokens": 0} for name in ("train", "valid")}
    seen = set()

    def add(messages, source):
        if not messages:
            return False
        if source == "smoltalk":
            # Keep the longest complete prefix that fits both budgets.
            ids, targets = conversation(tokenizer, messages[:2])
            kept = 2
            while kept < len(messages) and len(ids) <= cfg.context + 1 and sum(targets) <= args.answer_tokens:
                longer_ids, longer_targets = conversation(tokenizer, messages[:kept + 2])
                if len(longer_ids) > cfg.context + 1 or sum(longer_targets) > args.answer_tokens:
                    break
                ids, targets = longer_ids, longer_targets
                kept += 2
            messages = messages[:kept]
            text = " ".join(turn["content"] for turn in messages)
            if re.search(r"\b(?:ChatGPT|OpenAI|Llama|Meta AI)\b", text, re.I):
                return False
            if not 5 <= sum(targets) <= args.answer_tokens:
                return False
        else:
            ids, targets = conversation(tokenizer, messages)
        if len(ids) > cfg.context + 1:
            return False
        prompts = [turn["content"] for turn in messages if turn["role"] == "user"]
        digest = key("\n".join(prompts))
        if digest in seen:
            return False
        seen.add(digest)
        # Generic greetings are common across otherwise independent conversations.
        opening = next((text for text in prompts if len(text) >= 20), prompts[0])
        name = split(key(opening))
        handles[name].write(json.dumps([ids, targets, source], separators=(",", ":")) + "\n")
        stats[name]["conversations"] += 1
        stats[name]["tokens"] += len(ids)
        return True

    with (dest / "train.jsonl").open("w") as train, (dest / "valid.jsonl").open("w") as valid:
        handles.update(train=train, valid=valid)
        if args.synthetic:
            with args.synthetic.open() as handle:
                for line in handle:
                    add(clean_messages(json.loads(line)["messages"]), "jex")
        count = 0
        for raw in records(paths, "messages", args.seed):
            if add(clean_messages(raw), "smoltalk"):
                count += 1
                if count >= args.conversations:
                    break
    if count != args.conversations:
        raise ValueError(f"Only collected {count:,} of {args.conversations:,} requested conversations")
    return {**stats, "smoltalk_conversations": count, "jex_conversations": len(seen) - count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["pretrain", "chat"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path("corpus/raw"))
    parser.add_argument("--input", nargs="+", help="Use local parquet files instead of downloading")
    parser.add_argument("--characters", type=int, default=12_000_000)
    parser.add_argument("--tokenizer-docs", type=int, default=50_000)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--synthetic", type=Path)
    parser.add_argument("--conversations", type=int, default=10_000)
    parser.add_argument("--answer-tokens", type=int, default=144)
    parser.add_argument("--seed", type=int, default=124)
    args = parser.parse_args()
    if args.phase == "chat" and not args.tokenizer:
        parser.error("--tokenizer is required for chat")
    if min(args.characters, args.tokenizer_docs, args.conversations, args.answer_tokens) <= 0:
        parser.error("Data limits must be positive")
    cfg = Config(**json.loads(args.config.read_text()))
    if cfg.vocab_size > 65536:
        parser.error("The corpus format supports up to 65,536 tokens")
    if args.out.exists():
        parser.error("--out must be a new directory")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.out.parent) as temporary:
        dest = Path(temporary) / "ready"
        dest.mkdir()
        stats = (pretrain if args.phase == "pretrain" else chat)(args, dest, cfg)
        (dest / "stats.json").write_text(json.dumps(stats, indent=2) + "\n")
        dest.rename(args.out)
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
