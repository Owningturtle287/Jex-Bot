# Jex Pilot model card

Jex Pilot is an experimental English decoder-only language model with 935,040 parameters and a 256-token context. The browser build is 964,096 bytes of weights and scales plus its tokenizer and model metadata. Responses run in a local browser worker. The app keeps the current conversation in local browser storage, and New chat clears it.

## Training

| Stage | Data used | Optimizer steps | Target tokens processed | Held-out loss |
| --- | --- | ---: | ---: | --- |
| Pretraining from random initialization | FineWeb-Edu | 2,200 | 3,379,200 | 6.96 → 3.66 |
| Conversation tuning | 1,600 Everyday Conversations examples and 679 original Jex examples before splitting | 1,400 | 733,240 | 3.91 → 1.88 |
| Expanded conversation tuning | 1,600 Everyday Conversations examples and 3,881 original Jex examples before splitting | 1,700 | 728,670 | 1.64 → 1.15 |

Loss is mean token cross-entropy on a fixed validation sample for each stage. The last two stages count assistant and end-of-turn targets only. Loss values across stages use different validation data and objectives. The exported int8 model comes from step 1,600 of expanded tuning, which had the lowest validation loss in that stage.

## Evaluation

The exported model passed **12 of 16** checks in the [fixed development prompt suite](../data/pilot-eval.json). The checks use expected text patterns, and the first results informed later tuning. This is a small development check. Many prompts rephrase tasks represented in the synthetic data.

The release handled the greeting, identity, gravity, photosynthesis, a short thank-you note, and one familiar multi-turn recall example. It answered 4 plus 8 incorrectly, recalled the wrong words in an unfamiliar exchange, gave an unrelated answer to a cell biology question, and failed a new reasoning problem. Its replies can become irrelevant or incoherent outside the topics and patterns it practiced. It has no live web access.

The browser worker was verified with the shipped checkpoint for startup, streamed replies, and cancellation. Tokenization and last-token logits were compared against the dequantized PyTorch reference on plain English, literal control-marker text, and Unicode. The maximum observed absolute logit difference was below 0.00001.

See [training notes](training.md) for dataset attribution and the larger configuration.
