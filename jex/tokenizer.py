"""Train a byte-level BPE tokenizer and define the shared conversation format."""

from tokenizers import Regex, Tokenizer, decoders, models, pre_tokenizers, trainers

SPECIAL = ("<|pad|>", "<|bos|>", "<|end|>", "<|user|>", "<|jex|>", "<|system|>")
PAD, BOS, END, USER, JEX, SYSTEM = range(len(SPECIAL))
ROLE_IDS = {"user": USER, "assistant": JEX, "system": SYSTEM}
PATTERN = r"'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+"


def train_tokenizer(texts, vocab_size):
    tokenizer = Tokenizer(models.BPE())
    tokenizer.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(Regex(PATTERN), behavior="isolated"),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False),
    ])
    tokenizer.decoder = decoders.ByteLevel()
    tokenizer.train_from_iterator(texts, trainers.BpeTrainer(
        vocab_size=vocab_size,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        special_tokens=list(SPECIAL),
        show_progress=False,
    ))
    return _checked(tokenizer)


def _checked(tokenizer):
    if [tokenizer.token_to_id(token) for token in SPECIAL] != list(range(len(SPECIAL))):
        raise ValueError("Unexpected tokenizer control tokens")
    # A user typing a role marker gets ordinary byte tokens.
    tokenizer.encode_special_tokens = True
    return tokenizer


def load_tokenizer(path):
    return _checked(Tokenizer.from_file(str(path)))


def encode(tokenizer, text):
    return tokenizer.encode(text, add_special_tokens=False).ids


def conversation(tokenizer, messages):
    ids, targets = [BOS], [False]
    for message in messages:
        role = message["role"]
        text = encode(tokenizer, message["content"])
        ids.extend([ROLE_IDS[role], *text, END])
        targets.extend([False, *([role == "assistant"] * (len(text) + 1))])
    return ids, targets


def prompt_ids(tokenizer, messages, budget):
    turns = [
        [ROLE_IDS[message["role"]], *encode(tokenizer, message["content"]), END]
        for message in messages
    ]
    used = 2
    # Keep complete recent user/assistant pairs and truncate only the newest user text.
    if len(turns[-1]) > budget - used:
        turns[-1] = [USER, *turns[-1][-(budget - used - 1):]]
    kept = turns[-1:]
    used += len(turns[-1])
    for index in range(len(turns) - 3, -1, -2):
        pair = turns[index:index + 2]
        length = sum(map(len, pair))
        if used + length > budget:
            break
        kept[:0] = pair
        used += length
    return [BOS, *(token for turn in kept for token in turn), JEX]
