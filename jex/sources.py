"""Pinned upstream sources. Downloads and raw data stay outside the repository."""

FINEWEB = "https://huggingface.co/datasets/HuggingFaceFW/fineweb-edu"
FINEWEB_REV = "87f09149ef4734204d70ed1d046ddc9ca3f2b8f9"
SMOLTALK = "https://huggingface.co/datasets/HuggingFaceTB/smoltalk"
SMOLTALK_REV = "5feaf2fd3ffca7c237fc38d1861bc30365d48ffa"

PRETRAIN_URLS = [
    f"{FINEWEB}/resolve/{FINEWEB_REV}/sample/10BT/{index:03}_00000.parquet?download=true"
    for index in range(14)
]
CHAT_URLS = [
    f"{SMOLTALK}/resolve/{SMOLTALK_REV}/data/everyday-conversations/train-00000-of-00001.parquet?download=true",
    *[f"{SMOLTALK}/resolve/{SMOLTALK_REV}/data/smol-magpie-ultra/train-{index:05}-of-00006.parquet?download=true"
    for index in range(6)],
]
