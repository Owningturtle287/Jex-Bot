const normalize = text => text.replaceAll("’", "'").replace(/\s+/g, " ").trim();
const subjectKey = text => normalize(text).toLowerCase();
const FACT = /^(?:actually,?\s+)?(?:(?:please\s+)?remember (?:that )?)?my ([\p{L}\p{N}'’ -]{1,64}?)\s+(is|isn['’]t)\s+(.+)$/iu;
const PROFILE = /^i (live in|work as|prefer|enjoy|like)\s+(.+)$/iu;

export function memoryChanges(text, { chatId, messageId, at }) {
  const changes = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence || sentence.endsWith("?")) continue;
    const fact = FACT.exec(sentence);
    const profile = PROFILE.exec(sentence);
    let subject;
    let value;
    let key;
    if (fact) {
      subject = normalize(fact[1]);
      value = fact[3].replace(/[.!]+$/, "").replace(/\s+now$/i, "").trim();
      if (fact[2].toLowerCase() !== "is") value = "not " + value;
      if (/\b(?:and|but|although|because)\s+(?:i|we|he|she|they|it)\s+/i.test(value)) continue;
      key = "fact:" + subjectKey(subject);
    } else if (profile) {
      subject = profile[1].toLowerCase();
      value = profile[2].replace(/[.!]+$/, "").trim();
      key = "profile:" + subject;
    } else {
      const remembered = /^(?:please\s+)?remember(?: that)?\s+(.+)$/i.exec(sentence);
      if (!remembered) continue;
      subject = "note";
      value = remembered[1].trim();
      key = "note:" + chatId + ":" + messageId + ":" + changes.length;
    }
    if (!value || value.length > 500) continue;
    changes.push({ key, subject, value, text: sentence, chatId, messageId, updatedAt: at });
  }
  return changes;
}

export function forgetRequest(text) {
  const match = /^(?:please\s+)?forget my ([\p{L}\p{N}'’ -]{1,64})[.!]?$/iu.exec(normalize(text));
  return match && { key: "fact:" + subjectKey(match[1]), subject: match[1] };
}

export function validMemory(memory) {
  return typeof memory?.key === "string" && typeof memory.subject === "string" &&
    typeof memory.value === "string" && typeof memory.text === "string" &&
    Number.isFinite(memory.updatedAt) && !memory.deleted;
}

export function memoriesFromChats(chats) {
  const found = new Map();
  for (const chat of chats) {
    for (const [index, message] of chat.messages.entries()) {
      if (message.role !== "user") continue;
      const at = message.createdAt ?? chat.createdAt + index;
      const removal = forgetRequest(message.text);
      const changes = removal
        ? [{ key: removal.key, deleted: true, updatedAt: at }]
        : memoryChanges(message.text, { chatId: chat.id, messageId: message.id ?? String(index), at });
      for (const change of changes) {
        if (!found.has(change.key) || found.get(change.key).updatedAt <= change.updatedAt) found.set(change.key, change);
      }
    }
  }
  return [...found.values()];
}

export function memoryOverview(question, memories) {
  if (!/^(?:what (?:do you (?:know|remember) about me|have you (?:saved|remembered))|show (?:me )?(?:your|my) (?:saved )?(?:notes|memories))[?.!]*$/i.test(question.trim())) return;
  if (!memories.length) return "I haven’t saved any notes about you yet.";
  return "Here are the notes I have saved from what you told me.\n\n" +
    [...memories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)
      .map(memory => "• " + memory.text).join("\n");
}
