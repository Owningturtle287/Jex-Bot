# Jex Bot

Jex Bot is an experimental English chatbot trained from random weights. The first release is a small model that runs inside an installable web app. It generates replies in a browser worker, stores the current conversation on the device, and can run offline after its first successful load.

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
| [Base](configs/base.json) | 42,742,272 | 12 | 512 | 8 | 8,192 | 1,024 |

The decoder uses causal attention with rotary positions, RMSNorm, SwiGLU feed-forward layers, and a shared token embedding and output matrix. The browser ships with the quantized Pilot. Base is the starting configuration for a separate GPU training run.

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
