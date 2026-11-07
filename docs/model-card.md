# Jex v2 model card

Jex v2 is an experimental English decoder with 6,689,024 parameters and a 1,024-token context window. It expands the original 935,040-parameter Pilot, whose weights were trained from random initialization. The browser build contains 6,792,192 bytes of quantized weights and scales, plus model metadata and the unchanged byte-level tokenizer.

## Training

| Stage | Data | Steps | Assistant target tokens | Held-out loss |
| --- | --- | ---: | ---: | --- |
| Expanded model tuning | 8,301 original Jex examples and 2,400 external conversations before splitting | 1,800 | 912,705 | 2.67 → 1.51 |
| Short-conversation refinement | 8,301 original Jex examples and 1,600 external conversations before splitting | 700 | 278,926 | 0.668 → 0.680 |

Both runs used CPU bfloat16. The first stage widens the Pilot and adds identity residual blocks. Its initial logits match the Pilot within 0.00002 in the expansion check. Weight inspection after training confirmed that the copied features learned different values. The refinement experiment added a small matrix perturbation before further training.

The released checkpoint is the final refinement checkpoint. It retained the main pass's context score and restored earlier instruction and knowledge checks. Its token validation loss rose slightly. The two stages use different validation samples and length limits, so their loss values measure different objectives.

## Development checks

| Suite | Original Pilot | Exported Jex v2 |
| --- | ---: | ---: |
| Context and follow-up checks | 1 / 14 | 8 / 14 |
| Original prompt checks | 12 / 16 | 13 / 16 |

The checks use expected text patterns and were manually inspected. The context suite includes the reported failure patterns and tasks represented in the synthetic data. These scores measure development regressions. [Context cases](../data/context-eval.json) and [original cases](../data/pilot-eval.json).

The release answered the identity follow-up, responded appropriately to a positive casual reply, explained what kind of AI it is after a greeting exchange, retained familiar personal facts, and tracked one corrected preference. It still failed an unfamiliar name, some two-word recall tasks, 4 plus 8, a new factual question, and a new reasoning problem. Responses can remain irrelevant, inaccurate, or ungrammatical.

The model has no live web access. Its context is finite, so older turns are omitted once the prompt exceeds the available window.

## App verification

Conversations are stored separately in IndexedDB and ordered by the latest message. The previous single-conversation storage is imported automatically. New chat preserves earlier conversations. The live desktop browser was checked for migration, reopening chats, ordering after a new message, persistence after reload, and switching between conversations. A compact-screen drawer is included for phones.

The exported worker was checked for startup, streamed replies, and cancellation. Its tokenizer and logits matched the dequantized PyTorch reference on English text, literal role-marker text, and Unicode. The maximum observed logit error was below 0.000004. Model restoration from the published quantized format also passed.

## GPU training

This session had no attached CUDA GPU or connected GPU training service. The manual GPU workflow targets a Linux x64 self-hosted runner with the `gpu` label and trains the 42,742,272-parameter Base configuration. That workflow has not been executed. It requires an available CUDA runner. [GPU workflow](../.github/workflows/train-gpu.yml).

Dataset attribution and reproduction commands are in the [training notes](training.md) and [README](../README.md).
