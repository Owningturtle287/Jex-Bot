"""Run the browser model and calculator against Jex's development checks."""

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
RUN_CASE = """async ({ turns, checks, reject, case_sensitive, minimum_words = 0 }) => {
  const { arithmeticReply } = await import("./calculator.mjs");
  const { explicitFactReply } = await import("./facts.mjs");
  const { conversationRecall } = await import("./conversation-recall.mjs");
  const messages = turns.map((text, index) => ({
    role: index % 2 ? "assistant" : "user", text,
  }));
  let reply = arithmeticReply(messages) ?? conversationRecall(turns.at(-1), messages.slice(0, -1)) ??
    explicitFactReply(turns.at(-1), messages.slice(0, -1));
  if (reply === undefined) {
    reply = "";
    await window.evalModel.reply(messages, new AbortController().signal, text => { reply += text; });
    reply = reply.trim();
  }
  const matches = pattern => new RegExp(pattern, case_sensitive ? "" : "i").test(reply);
  return { passed: checks.every(matches) && !(reject ?? []).some(matches) &&
    reply.split(/\\s+/).length >= minimum_words, reply };
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8000/")
    parser.add_argument("--model", choices=["local", "strong"], default="local")
    parser.add_argument("--prompts", type=Path, nargs="+", default=[
        ROOT / "data" / "context-eval.json", ROOT / "data" / "browser-eval.json",
        ROOT / "data" / "identity-eval.json",
    ])
    args = parser.parse_args()

    with sync_playwright() as playwright, playwright.chromium.launch(args=["--no-sandbox"]) as browser:
        page = browser.new_page(service_workers="block")
        page.goto(args.url)
        page.evaluate("""async modelId => {
          const { loadLocalModel } = await import("./local-model.mjs");
          window.evalModel = await loadLocalModel({ modelId, allowDownload: true });
        }""", args.model)
        for path in args.prompts:
            cases = json.loads(path.read_text())
            passed = 0
            for case in cases:
                result = page.evaluate(RUN_CASE, case)
                passed += result["passed"]
                print(json.dumps({"label": case["label"], **result}, ensure_ascii=False), flush=True)
            print(json.dumps({"suite": path.name, "passed": passed, "total": len(cases)}))


if __name__ == "__main__":
    main()
