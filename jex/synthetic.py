"""Generate small, original English examples with deterministic answers."""

import argparse
import json
from pathlib import Path


def turn(role, content):
    return {"role": role, "content": content}


def examples(seed, expanded=False):
    for questions, answer in json.loads(seed.read_text()):
        for question in questions:
            yield [turn("user", question), turn("assistant", answer)]
            if expanded:
                for prefix, suffix in (
                    ("", " Please keep it simple."), ("Hey Jex. ", ""), ("", " Please."),
                    ("Quick question. ", ""), ("", " A short reply is fine."),
                    ("Hi there. ", " Thanks!"), ("Please answer this. ", ""),
                    ("", " Use simple English."), ("I'd like to know. ", ""),
                ):
                    yield [turn("user", prefix + question + suffix), turn("assistant", answer)]

    animals = ("cat", "dog", "rabbit", "fox", "owl", "turtle", "horse", "bear",
               "goat", "panda", "otter", "frog", "duck", "mouse", "deer", "wolf")
    colors = ("blue", "green", "red", "yellow", "purple", "orange", "pink", "white")
    for color in colors:
        for animal in animals:
            yield [
                turn("user", f"Please remember the words {color} {animal}."),
                turn("assistant", f"Got it. I'll remember {color} {animal} during this conversation."),
                turn("user", "What words did I ask you to remember?"),
                turn("assistant", f"You asked me to remember {color} {animal}."),
            ]
            yield [
                turn("user", f"My favorite animal is a {animal}, and my favorite color is {color}."),
                turn("assistant", "Thanks for telling me!"),
                turn("user", "What color did I say I liked best?"),
                turn("assistant", f"You said your favorite color is {color}."),
            ]
    for item in (*animals, *colors, "river", "moon", "cloud", "star", "peach", "pear"):
        yield [turn("user", f"Repeat the word {item}."), turn("assistant", item)]
        yield [turn("user", f"Write {item} in uppercase."), turn("assistant", item.upper())]
        yield [
            turn("user", f"Say the word {item} three times with commas between."),
            turn("assistant", ", ".join([item] * 3)),
        ]
    for first in range(1, 13):
        for second in range(1, 13):
            question = (f"What is {first} plus {second}?" if (first + second) % 2
                        else f"Add {first} and {second}.")
            yield [turn("user", question), turn("assistant", str(first + second))]

    if expanded:
        for words, answer in json.loads(seed.with_name("topics.json").read_text()):
            for topic in words:
                for question in (
                    f"Tell me about {topic}.",
                    f"Could you explain {topic} to a beginner?",
                    f"I'd like to understand {topic}.",
                    f"Help me understand {topic}.",
                    f"Explain {topic} in your own words.",
                    f"Give me a quick explanation of {topic}.",
                    f"Can you describe {topic}?",
                ):
                    yield [turn("user", question), turn("assistant", answer)]
        for first in range(1, 13):
            for second in range(1, 13):
                for question in (
                    f"Calculate {first} + {second}.",
                    f"What's the sum of {first} and {second}?",
                    f"If I have {first} apples and get {second} more, how many apples do I have?",
                ):
                    yield [turn("user", question), turn("assistant", str(first + second))]
        for item in (*animals, *colors, "river", "moon", "cloud", "star", "peach", "pear"):
            for question in (
                f"Make {item} all caps.",
                f"Can you put {item} in uppercase?",
                f"Uppercase this word for me: {item}",
                f"Convert {item} to capital letters.",
            ):
                yield [turn("user", question), turn("assistant", item.upper())]
        for color in colors:
            for animal in animals:
                yield [
                    turn("user", f"I like the color {color}, and I really like {animal}s."),
                    turn("assistant", "Thanks for telling me!"),
                    turn("user", "Can you remind me which color I like?"),
                    turn("assistant", f"You said you like {color}."),
                ]
                yield [
                    turn("user", f"Keep these words in mind: {color} {animal}."),
                    turn("assistant", f"Okay, I'll remember {color} {animal}."),
                    turn("user", "Can you repeat the two words I mentioned?"),
                    turn("assistant", f"You mentioned {color} {animal}."),
                ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=Path("data/seed.json"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--expanded", action="store_true")
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as handle:
        for messages in examples(args.seed, args.expanded):
            handle.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
