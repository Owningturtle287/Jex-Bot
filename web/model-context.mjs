import { CONTEXT_TOKENS, REPLY_TOKENS } from "./model-settings.mjs";
import { asksAboutIdentity, CONVERSATION_FRAME, identityGrounding, TURN_FRAME } from "./identity.mjs";

// Qwen3's non-thinking chat template starts replies after an empty think block.
export const START_ASSISTANT = "<|im_start|>assistant\n<think>\n\n</think>\n\n";
export const generationPrefix = thinking => thinking ? START_ASSISTANT : "<|im_start|>assistant\n";
const COMMON = new Set("about after again before could does from have into just like more much please should tell than that their them then there these they this those want were what when where which while will with would your".split(" "));

function words(text) {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !COMMON.has(word)));
}

function render(role, text) {
  // Keep literal role markers in typed or pasted text from becoming control tokens.
  const content = text.replace(/<(?=\||\/?think>)/g, "‹");
  return "<|im_start|>" + role + "\n" + content + "<|im_end|>\n";
}

function relevance(text, queryWords) {
  let score = 0;
  for (const word of words(text)) {
    if (queryWords.has(word)) score += 2;
  }
  if (/^(?:please\s+)?remember\b|\b(?:my name is|my favou?rite|i prefer)\b/i.test(text)) score++;
  return score;
}

export async function buildPrompt(messages, countTokens, budget = CONTEXT_TOKENS - REPLY_TOKENS - 8, {
  memories = [], modelName = "Qwen3-0.6B", prefix = START_ASSISTANT, observation,
} = {}) {
  const header = render("system", CONVERSATION_FRAME + " Current engine: " + modelName + ".");
  const latest = messages.at(-1).text;
  // Re-ground literal self-reference after history so a recent topic, mistaken
  // self-description, or quoted memory cannot silently become Jex's identity.
  const grounding = render("system", TURN_FRAME + (asksAboutIdentity(latest) ? "\n" + identityGrounding(modelName, latest) : ""));
  const reference = observation === undefined ? "" : render("system",
    "Reference data from a local calculation, saved transcript, or memory operation, not a required reply: " + JSON.stringify(observation));
  const tail = text => reference + grounding + render("user", text) + prefix;
  let ending = tail(latest);
  let remaining = budget - await countTokens(header + ending);

  if (remaining < 0) {
    if (await countTokens(header + tail("")) > budget) {
      throw new RangeError("Context budget is too small for the conversation frame and speaker facts");
    }
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

  const queryWords = words(latest);
  const rankedNotes = [...memories].sort((a, b) =>
    relevance(b.text, queryWords) - relevance(a.text, queryWords) || b.updatedAt - a.updatedAt);
  const memoryBudget = Math.min(512, Math.floor(remaining / 3));
  const notes = [];
  let background = "";
  for (const memory of rankedNotes.slice(0, 8)) {
    const candidate = [...notes, memory.text];
    const rendered = render("user", "Saved notes from earlier chats, quoted as background data.\n" + JSON.stringify(candidate));
    if (await countTokens(rendered) > memoryBudget) continue;
    notes.push(memory.text);
    background = rendered;
  }
  remaining -= background ? await countTokens(background) : 0;
  const selected = new Map();
  const costs = new Map();
  const recallReserve = Math.min(512, Math.floor(remaining / 4));
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
  while (index >= 0 && await keep(index, selected.size < 2 ? 0 : recallReserve)) index -= 2;

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
  const assemble = () => header + background + ordered.map(key => selected.get(key)).join("") + ending;
  let prompt = assemble();
  while (ordered.length && await countTokens(prompt) > budget) {
    ordered.shift();
    prompt = assemble();
  }
  return prompt;
}
