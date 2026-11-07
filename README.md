# Jex Bot

Jex Bot is an experimental English chatbot trained from random weights. The first release is a small model that runs inside an installable web app. It generates replies in a browser worker, saves separate conversations on the device, and can run offline after its first successful load.

[Open Jex Bot](https://owningturtle287.github.io/Jex-Bot/).

Saved conversations appear on the left, ordered by the latest message. On a phone, tap Chats to open the list. New chat preserves earlier conversations. The previous single conversation is imported automatically. History is stored in this browser using IndexedDB.

## Run the app

```sh
python -m http.server 8000 --bind 127.0.0.1 --directory web
```

Open [localhost:8000](http://localhost:8000). The bundled model needs no Python inference server, account, or API key. A phone needs an HTTPS copy of the `web/` directory to install it. On iPhone, use Safari → Share → Add to Home Screen. On Android, use your browser’s Install app or Add to Home screen menu.

Try a short greeting, a question about gravity, or a request for a joke. See the [model card](docs/model-card.md) for the pilot’s evaluation results and known limits.

## Model configurations

| Configuration | Parameters | Transformer blocks | Width | Attention heads | BPE vocabulary | Context |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Pilot](configs/pilot.json) | 935,040 | 4 | 128 | 4 | 1,024 | 256 |
| [Jex v2](configs/jex-v2.json) | 6,689,024 | 8 | 256 | 8 | 1,024 | 1,024 |
| [Base](configs/base.json) | 42,742,272 | 12 | 512 | 8 | 8,192 | 1,024 |

The decoder uses causal attention with rotary positions, RMSNorm, SwiGLU feed-forward layers, and a shared token embedding and output matrix. The browser ships with the quantized Jex v2 model. Base is the starting configuration for a separate GPU training run.

## Reproduce the Pilot

Use Python 3.11 or newer. The data pipeline downloads pinned parquet files and keeps them in the ignored `corpus/` directory. The first FineWeb-Edu shard is about 2 GB. To reuse downloads, pass local parquet paths with `--input` in source order.

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

python -m jex.prepare pretrain --config configs/pilot.json \
  --out corpus/pilot-pretrain --characters 18000000
python -m jex.train pretrain --config configs/pilot.json --data corpus/pilot-pretrain \
  --out runs/pilot-pretrain --device cpu --bf16 --threads 6 --length 128 --batch 12 \
  --steps 2200 --eval-every 200 --eval-batches 12

python -m jex.synthetic --out corpus/synthetic.jsonl
python -m jex.prepare chat --config configs/pilot.json --out corpus/jex-pilot-chat \
  --tokenizer corpus/pilot-pretrain/tokenizer.json --synthetic corpus/synthetic.jsonl \
  --conversations 1600 --answer-tokens 200
python -m jex.train chat --config configs/pilot.json --data corpus/jex-pilot-chat \
  --out runs/jex-pilot-chat --init runs/pilot-pretrain/best.pt --device cpu --bf16 \
  --threads 6 --batch 10 --lr .00065 --jex-weight .76 --steps 1400 \
  --eval-every 200 --eval-batches 32

python -m jex.synthetic --expanded --out corpus/synthetic-expanded.jsonl
python -m jex.prepare chat --config configs/pilot.json --out corpus/jex-expanded \
  --tokenizer corpus/pilot-pretrain/tokenizer.json --synthetic corpus/synthetic-expanded.jsonl \
  --conversations 1600 --answer-tokens 200
python -m jex.train chat --config configs/pilot.json --data corpus/jex-expanded \
  --out runs/jex-expanded --init runs/jex-pilot-chat/best.pt --device cpu --bf16 \
  --threads 6 --batch 10 --lr .00075 --jex-weight .88 --steps 1700 \
  --eval-every 200 --eval-batches 32

python -m jex.export --checkpoint runs/jex-expanded/best.pt \
  --tokenizer corpus/pilot-pretrain/tokenizer.json --out web/model
python -m jex.evaluate --model web/model
```

Omit `--bf16` if your CPU lacks efficient bfloat16 support. To restart an interrupted training run, repeat its command with the same options and replace `--init ...`, if present, with `--resume`. Each evaluation writes metrics and an atomic `last.pt` with optimizer and sampler state. When serving an updated export, remove obsolete model shards and bump the cache version in `web/sw.js`.

To initialize a new fine-tuning run from the released int8 weights, use `python -m jex.restore --out runs/pilot-init.pt`, then supply that file as `--init`. Use the checked-in `data/pilot-tokenizer.json` when preparing the new chat data. The restored weights retain quantization error and require a fresh optimizer.

The [training notes](docs/training.md) document dataset provenance and the GPU training path.

## Continue with Jex v2

The larger model is initialized by widening the trained Pilot and adding identity residual blocks. This preserves the Pilot's initial predictions while making room for additional training. An additional short-conversation tuning pass applies a small matrix perturbation and is assessed with the development checks. The refinement corpus uses the Pilot preparation limit of 256 tokens while the trained model retains its 1,024-token window.

```sh
python -m jex.grow --checkpoint runs/jex-expanded/best.pt \
  --config configs/jex-v2.json --out runs/jex-v2-init.pt
python -m jex.context_data --out corpus/context-v2.jsonl
python -m jex.prepare chat --config configs/jex-v2.json --out corpus/context-v2 \
  --tokenizer data/pilot-tokenizer.json --synthetic corpus/context-v2.jsonl \
  --conversations 2400 --answer-tokens 400
python -m jex.train chat --config configs/jex-v2.json --data corpus/context-v2 \
  --out runs/jex-v2 --init runs/jex-v2-init.pt --device cpu --bf16 --threads 6 \
  --batch 8 --lr .00035 --jex-weight .88 --steps 1800 --eval-every 200 --eval-batches 20
python -m jex.prepare chat --config configs/pilot.json --out corpus/short-v2 \
  --tokenizer data/pilot-tokenizer.json --synthetic corpus/context-v2.jsonl \
  --conversations 1600 --answer-tokens 200
python -m jex.train chat --config configs/jex-v2.json --data corpus/short-v2 \
  --out runs/jex-v2-refine --init runs/jex-v2/best.pt --init-noise .0001 \
  --device cpu --bf16 --threads 6 --batch 8 --lr .00015 --jex-weight .92 \
  --steps 700 --warmup 30 --eval-every 100 --eval-batches 24
python -m jex.export --checkpoint runs/jex-v2-refine/last.pt \
  --tokenizer data/pilot-tokenizer.json --out web/model --name "Jex v2"
python -m jex.evaluate --model web/model --prompts data/context-eval.json
```

If only the released quantized weights are available, restore them with `jex.restore` to initialize further tuning. The tokenizer must remain unchanged.

## GPU training

The manual **Train Jex on GPU** GitHub Actions workflow trains the 42.7-million-parameter Base configuration from scratch. It requires a Linux x64 self-hosted runner with an NVIDIA GPU and the `gpu` label. The workflow checks CUDA, selects bfloat16 or scaled float16, and uploads checkpoints and evaluation artifacts. It does not provision hardware or publish a model automatically.

To use an existing CUDA environment directly, install the requirements and run `bash scripts/train-gpu.sh`. The default pretraining budget is approximately 800 million consumed tokens. The optional arguments set pretraining and conversation tuning steps. Checkpoints and optimizer state can be resumed with the trainer's `--resume` option.
