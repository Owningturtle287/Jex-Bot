"""Run the pilot's fixed prompt checks with the same decoding policy as the app."""

import argparse
import json
from pathlib import Path
import re

import torch

from .model import Config, Jex
from .restore import restore
from .train import digest
from .tokenizer import END, SPECIAL, load_tokenizer, prompt_ids


@torch.inference_mode()
def generate(model, tokenizer, messages):
    limit = min(112, model.cfg.context // 2)
    ids = prompt_ids(tokenizer, messages, model.cfg.context - limit)
    generated = []
    for _ in range(limit):
        logits = model(torch.tensor([ids + generated]), last_only=True)[0, 0]
        logits[:END] = float("-inf")
        logits[END + 1:len(SPECIAL)] = float("-inf")
        if len(generated) >= 2:
            for a, b, c in zip(generated, generated[1:], generated[2:]):
                if [a, b] == generated[-2:]:
                    logits[c] = float("-inf")
        token = int(logits.argmax())
        if token == END:
            break
        generated.append(token)
    return tokenizer.decode(generated).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--checkpoint", type=Path)
    group.add_argument("--model", type=Path)
    parser.add_argument("--tokenizer", type=Path, default=Path("data/pilot-tokenizer.json"))
    parser.add_argument("--prompts", type=Path, default=Path("data/pilot-eval.json"))
    args = parser.parse_args()
    torch.set_num_threads(2)
    state = (restore(args.model, args.tokenizer) if args.model else
             torch.load(args.checkpoint, map_location="cpu", weights_only=True))
    if state["tokenizer_sha256"] != digest(args.tokenizer):
        parser.error("Checkpoint tokenizer does not match")
    tokenizer = load_tokenizer(args.tokenizer)
    model = Jex(Config(**state["config"])).eval()
    model.load_state_dict(state["model"])
    cases = json.loads(args.prompts.read_text())
    passed = 0
    for case in cases:
        messages = [{"role": "assistant" if i % 2 else "user", "content": text}
                    for i, text in enumerate(case["turns"])]
        reply = generate(model, tokenizer, messages)
        flags = 0 if case.get("case_sensitive") else re.I
        success = all(re.search(pattern, reply, flags) for pattern in case["checks"])
        success = success and not any(re.search(pattern, reply, flags) for pattern in case.get("reject", []))
        passed += success
        print(json.dumps({"label": case["label"], "passed": success, "reply": reply}, ensure_ascii=False))
    print(json.dumps({"passed": passed, "total": len(cases)}))


if __name__ == "__main__":
    main()
