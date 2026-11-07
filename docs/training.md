# Training data and scaling

| Stage | Source | License and provenance |
| --- | --- | --- |
| English pretraining | [FineWeb-Edu 10B-token sample](https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu/tree/87f09149ef4734204d70ed1d046ddc9ca3f2b8f9/sample/10BT) | The Hugging Face dataset card lists ODC-By 1.0. The source material is educational English web text derived from Common Crawl. |
| Conversation tuning | [SmolTalk Everyday Conversations](https://huggingface.co/datasets/HuggingFaceTB/smoltalk/tree/5feaf2fd3ffca7c237fc38d1861bc30365d48ffa/data/everyday-conversations) | The [original dataset card](https://huggingface.co/datasets/HuggingFaceTB/everyday-conversations-llama3.1-2k) lists Apache 2.0. The conversations were generated with Llama 3.1 70B Instruct. |
| Available for larger tuning runs | [SmolTalk Smol-Magpie-Ultra](https://huggingface.co/datasets/HuggingFaceTB/smoltalk/tree/5feaf2fd3ffca7c237fc38d1861bc30365d48ffa/data/smol-magpie-ultra) | The [SmolTalk dataset card](https://huggingface.co/datasets/HuggingFaceTB/smoltalk) lists Apache 2.0 for this subset. |
| Conversation tuning | [Jex examples](../data/seed.json) and [generator](../jex/synthetic.py) | Original examples for chatbot identity, simple questions, turn recall, formatting, and small arithmetic tasks. |

The repository distributes processed model weights, the tokenizer, and original Jex examples. The upstream corpora are downloaded on demand. FineWeb-Edu can contain errors, unwanted text, and near-duplicates. Synthetic conversations can carry errors and biases from their source models. The Pilot started with newly initialized weights. It used FineWeb-Edu for pretraining and Everyday Conversations plus the original Jex examples for both tuning passes.

Pretraining deduplicates normalized documents before a deterministic train and validation split. The byte-level tokenizer learns from training documents only. Chat preparation keeps complete turns, filters source-model identity mentions and overlong responses, deduplicates normalized prompts, and groups alternate continuations of the same substantive opening prompt into one split. Chat loss applies to assistant answer tokens and the end-of-turn marker. The prompt suite is separate from validation loss. The fixed development prompt suite tests familiar tasks with rephrased prompts and some deliberately unfamiliar tasks. Its first results informed the second tuning pass.

## Train a larger Jex model

Use `configs/base.json` with the same commands and new run directories. Train its tokenizer on fresh Base corpus data. Model size, data volume, and token budget should grow together. [Hoffmann et al., Training Compute-Optimal Large Language Models](https://arxiv.org/abs/2203.15556).

A first Base experiment can use approximately 800 million consumed training tokens. One example is 24,414 optimizer steps at 32,768 tokens per step, with a starting learning rate of `0.0006` and 1,000 warmup steps. Set `--device cuda --bf16 --length 1024 --batch 8 --accumulate 4` for a CUDA GPU with bfloat16 support. If memory is tight, reduce the batch size and increase accumulation in the same proportion. Start with a short throughput run on the target hardware before deciding the full training schedule. The current trainer is single-device and data preparation keeps the selected documents in RAM.

Track held-out loss and evaluate fresh prompts for relevance, instruction-following, factual accuracy, and retention across turns before promoting a checkpoint. Exporting Base to a phone needs separate latency and memory measurements. The included web runtime and service-worker cache have been sized for the Pilot.

## Conversation continuity

The v2 training pass expands the learned Pilot to 6,689,024 parameters, preserving its initial logits before tuning. Weight inspection after the main pass showed that copied features had already diverged. A separate short-conversation experiment applied a small matrix perturbation before further tuning. The context grows from 256 to 1,024 tokens. The original examples in `jex/context_data.py` add follow-up questions, casual replies, identity questions after greetings, remembered facts, and corrected preferences. The external mix includes complete prefixes from Everyday Conversations and Smol-Magpie-Ultra.

The new `data/context-eval.json` suite includes the reported failure patterns and separate name, correction, recall, fact, and reasoning cases. The screenshot patterns were included in training. Treat these checks as a development regression suite.

The GPU workflow uses mixed precision and gradient scaling for float16, including unscaling before gradient clipping and saving the scaler state for resume. [PyTorch AMP examples](https://docs.pytorch.org/docs/stable/notes/amp_examples.html).

The current session had no attached CUDA GPU or connected GPU training service. The v2 runs used CPU bfloat16. The GPU workflow is prepared for a separately connected CUDA runner.
