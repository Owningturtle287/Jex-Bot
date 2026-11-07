#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root in an environment with CUDA-enabled PyTorch.
pretrain_steps="${1:-10000}"
chat_steps="${2:-4000}"
if ! [[ "$pretrain_steps" =~ ^[1-9][0-9]*$ && "$chat_steps" =~ ^[1-9][0-9]*$ ]]; then
  echo "Training step counts must be positive integers." >&2
  exit 2
fi
precision="$(python - <<'PY'
import torch
if not torch.cuda.is_available():
    raise SystemExit("A CUDA GPU is required. This script does not provision a GPU.")
print("--bf16" if torch.cuda.is_bf16_supported() else "--fp16")
PY
)"
python -m jex.prepare pretrain --config configs/base.json   --out corpus/base-pretrain --characters 240000000
python -m jex.train pretrain --config configs/base.json   --data corpus/base-pretrain --out runs/base-pretrain --device cuda "$precision"   --length 1024 --batch 8 --accumulate 4 --steps "$pretrain_steps"   --lr .0006 --warmup 1000 --eval-every 500 --eval-batches 16
python -m jex.context_data --out corpus/base-context.jsonl
python -m jex.prepare chat --config configs/base.json --out corpus/base-chat   --tokenizer corpus/base-pretrain/tokenizer.json --synthetic corpus/base-context.jsonl   --conversations 12000 --answer-tokens 512
python -m jex.train chat --config configs/base.json --data corpus/base-chat   --out runs/base-chat --init runs/base-pretrain/best.pt --device cuda "$precision"   --batch 8 --accumulate 2 --steps "$chat_steps" --lr .0002 --warmup 200   --jex-weight .35 --eval-every 200 --eval-batches 32
python -m jex.export --checkpoint runs/base-chat/best.pt   --tokenizer corpus/base-pretrain/tokenizer.json --out runs/base-export --name "Jex Base"
python -m jex.evaluate --model runs/base-export   --tokenizer corpus/base-pretrain/tokenizer.json | tee runs/base-evaluation.jsonl
