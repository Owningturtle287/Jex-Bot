"""Original multi-turn practice for conversation continuity and reference tracking."""

import argparse
import json
from pathlib import Path
import random

from .synthetic import examples, turn


def conversations(seed):
    # Preserve the existing English and instruction practice.
    yield from examples(seed, expanded=True)
    followups = ("Are you sure?", "You sure about that?", "Really?", "Can you say that again?",
                 "Please explain that again.", "Could you remind me what you said?")
    for questions, answer in json.loads(seed.read_text()):
        for question in questions[:3]:
            for followup in followups:
                yield [turn("user", question), turn("assistant", answer),
                       turn("user", followup), turn("assistant", answer)]
            yield [turn("user", question), turn("assistant", answer),
                   turn("user", "What did I just ask you?"), turn("assistant", f"You asked: {question}")]

    greetings = ("Hi", "Hey!", "Hello :)", "Hey there", "Hello Jex", "Good morning", "Hi there!")
    moods = ("I'm good", "I'm doing well.", "Pretty good, thanks.", "Not bad!", "I'm fine.",
             "I'm great today.", "Doing okay.", "Good, how about you?")
    identities = ("Well tell me...do you know what you are exactly?", "What are you exactly?",
                  "Do you know who you are?", "Are you a human?", "What kind of program are you?",
                  "Are you actually an AI?", "Tell me what you are.")
    for greeting in greetings:
        for mood in moods:
            intro = [
                turn("user", greeting),
                turn("assistant", "Hello! How are you doing today?"),
                turn("user", mood),
                turn("assistant", "Glad to hear it. What's on your mind?"),
            ]
            yield intro
            for question in identities:
                yield [*intro, turn("user", question), turn("assistant",
                    "I'm Jex Bot, an AI language model. I generate text in response to your messages. "
                    "I can make mistakes, and I don't have feelings or human awareness.")]
    for question in ("What is your name?", "Who are you?", "What do people call you?"):
        for followup in followups:
            yield [
                turn("user", question), turn("assistant", "I'm Jex Bot, an AI language model."),
                turn("user", followup), turn("assistant", "Yes. I'm Jex Bot, an AI language model."),
            ]

    rng = random.Random(9247)
    names = ("Maya", "Eli", "Nora", "Sam", "Alex", "June", "Leo", "Iris", "Kai", "Rose",
             "Ada", "Ben", "Zoe", "Liam", "Ava", "Theo", "Mila", "Luna", "Owen", "Eva")
    colors = ("red", "blue", "green", "yellow", "orange", "purple", "pink", "silver", "gold", "black")
    animals = ("cat", "dog", "fox", "rabbit", "owl", "turtle", "panda", "dolphin", "otter", "horse")
    hobbies = ("drawing", "hiking", "reading", "cooking", "swimming", "gardening", "cycling", "music")
    seen = set()
    for _ in range(2800):
        name, color, animal, hobby = rng.choice(names), rng.choice(colors), rng.choice(animals), rng.choice(hobbies)
        facts = (name, color, animal, hobby)
        if facts in seen:
            continue
        seen.add(facts)
        yield [
            turn("user", f"My name is {name}. I like {color}, {animal}s, and {hobby}."),
            turn("assistant", f"Nice to meet you, {name}!"),
            turn("user", "Can you remind me what I told you about myself?"),
            turn("assistant", f"Your name is {name}. You like {color}, {animal}s, and {hobby}."),
        ]
        if len(seen) % 3 == 0:
            updated = rng.choice([word for word in colors if word != color])
            yield [
                turn("user", f"My favorite color is {color}."),
                turn("assistant", f"Got it. Your favorite color is {color}."),
                turn("user", f"Actually, my favorite color is {updated} now."),
                turn("assistant", f"Thanks for the update. Your favorite color is {updated}."),
                turn("user", "What is my favorite color now?"),
                turn("assistant", f"Your favorite color is {updated}."),
            ]
        if len(seen) % 2 == 0:
            yield [
                turn("user", f"Remember these two words: {color} {animal}."),
                turn("assistant", f"Okay. I'll remember {color} {animal}."),
                turn("user", "What were the two words?"),
                turn("assistant", f"The two words were {color} {animal}."),
            ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=Path("data/seed.json"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as handle:
        for messages in conversations(args.seed):
            handle.write(json.dumps({"messages": messages}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
