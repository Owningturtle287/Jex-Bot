import { CONTEXT_TOKENS, REPLY_TOKENS } from "./model-settings.mjs";

const SYSTEM = "You are Jex Bot, an on-device AI assistant powered by Qwen. If asked who you are, give your name. " +
  "Answer directly and keep simple answers brief. Quote recalled names and details exactly as the user wrote them. " +
  "Use the user's latest correction. If challenged, check your last answer. Ask for clarification when needed.";
const START_ASSISTANT = "<|im_start|>assistant\n";
const COMMON = new Set("about after again before could does from have into just like more much please should tell than that their them then there these they this those want were what when where which while will with would your".split(" "));

function words(text) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !COMMON.has(word)));
}

function render(role, text) {
  // Keep literal role markers in typed or pasted text from becoming control tokens.
  return "<|im_start|>" + role + "\n" + text.replaceAll("<|", "‹|") + "<|im_end|>\n";
}

function relevance(text, queryWords) {
  let score = 0;
  for (const word of words(text)) {
    if (queryWords.has(word)) score += 2;
  }
  if (/^(?:please\s+)?remember\b|\b(?:my name is|my favou?rite|i prefer)\b/i.test(text)) score++;
  return score;
}

export async function buildPrompt(messages, countTokens, budget = CONTEXT_TOKENS - REPLY_TOKENS - 8) {
  const header = render("system", SYSTEM);
  const latest = messages.at(-1).text;
  const tail = text => render("user", text) + START_ASSISTANT;
  let ending = tail(latest);
  let remaining = budget - await countTokens(header + ending);

  if (remaining < 0) {
    // Very dense Unicode can exceed the token budget despite the input's character limit.
    const characters = Array.from(latest);
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      const part = tail(characters.slice(-size).join(""));
      if (await countTokens(header + part) <= budget) {
        low = size;
        ending = part;
      } else {
        high = size - 1;
      }
    }
    return header + (low ? ending : tail(""));
  }

  const selected = new Map();
  const costs = new Map();
  const recentFloor = Math.min(512, Math.floor(remaining / 4));
  const pairAt = index => render("user", messages[index].text) + render("assistant", messages[index + 1].text);
  const keep = async (index, reserve = 0) => {
    const pair = pairAt(index);
    const cost = costs.get(index) ?? await countTokens(pair);
    costs.set(index, cost);
    if (cost > remaining - reserve) return false;
    selected.set(index, pair);
    remaining -= cost;
    return true;
  };

  let index = messages.length - 3;
  while (index >= 0 && await keep(index, selected.size < 2 ? 0 : recentFloor)) index -= 2;

  const queryWords = words(latest);
  const candidates = [];
  for (let old = index; old >= 0; old -= 2) {
    const score = relevance(messages[old].text, queryWords);
    if (score) candidates.push({ index: old, score });
  }
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  for (const candidate of candidates.slice(0, 4)) await keep(candidate.index);

  for (; index >= 0; index -= 2) {
    if (!selected.has(index) && !await keep(index)) break;
  }
  const ordered = [...selected.keys()].sort((a, b) => a - b);
  const assemble = () => header + ordered.map(key => selected.get(key)).join("") + ending;
  let prompt = assemble();
  while (ordered.length && await countTokens(prompt) > budget) {
    ordered.shift();
    prompt = assemble();
  }
  return prompt;
}
