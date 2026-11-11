import { forgetRequest } from "./memory.mjs";

const SUBJECT = "[\\p{L}\\p{N}'’ -]{1,64}";
const QUESTION = new RegExp(
  "^(?:what(?:'s| is)|can you recall) my (" + SUBJECT + "?)\\??" +
  "(?:\\s+reply with (?:just|only) the (?:name|value)\\.?)?$", "iu",
);
const STATEMENT = new RegExp(
  "^(?:actually,?\\s+)?(?:(?:please\\s+)?remember (?:that )?)?my (" + SUBJECT + "?)\\s+(is|isn['’]t)\\s+(.+)$", "iu",
);
const normalize = text => text.replaceAll("’", "'").replace(/\s+/g, " ").trim();

export function explicitFactReply(question, history, memories = []) {
  const request = QUESTION.exec(normalize(question));
  if (!request) return;
  const subject = request[1].toLowerCase();
  const remembered = memories.find(memory => memory.key === "fact:" + subject);
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "user") continue;
    if (forgetRequest(message.text)?.key === "fact:" + subject) return "I don’t have that saved.";
    const sentences = message.text.split(/(?<=[.!?])\s+|\n+/);
    for (const sentence of sentences.reverse()) {
      const text = sentence.trim();
      const statement = STATEMENT.exec(text);
      if (!statement || normalize(statement[1]).toLowerCase() !== subject || text.endsWith("?")) continue;
      // A correction in another chat can be newer than this thread's transcript.
      if (remembered && (!Number.isFinite(message.createdAt) || remembered.updatedAt >= message.createdAt)) {
        return /^(?:not\b|unknown$)/i.test(remembered.value) ? undefined : remembered.value;
      }
      const value = statement[3].replace(/[.!]+$/, "").replace(/\s+now$/i, "").trim();
      if (statement[2].toLowerCase() !== "is" || /^(?:not\b|unknown$)/i.test(value) ||
          /\b(?:and|but|although|because)\s+(?:i|we|he|she|they|it)\s+/i.test(value)) return;
      return value;
    }
  }
  if (remembered && !/^(?:not\b|unknown$)/i.test(remembered.value)) return remembered.value;
  if (!history.some(message => message.role === "user")) return "You haven’t shared that in this chat.";
}
