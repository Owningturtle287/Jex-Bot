const questionText = text => /[?？]\s*$|^(?:what|who|when|where|why|how|which|can|could|would|do|does|did|is|are|was|were|will|have|has)\b/i.test(text.trim());

export function conversationRecall(question, history) {
  const request = question.trim().replace(/[?.!]+$/, "");
  const match = /^(?:what (?:was|is)|tell me) (?:the )?(first|last|previous) (question|message|thing) (?:that )?(i (?:asked|sent|said)(?: (?:you|to you))?|you (?:asked|sent|said)(?: (?:me|to me))?)(?: (?:in this chat|before (?:this|that)))?$/i.exec(request);
  if (!match) return;
  const role = /^i /i.test(match[3]) ? "user" : "assistant";
  const candidates = history.filter(message => message.role === role &&
    (match[2].toLowerCase() !== "question" || questionText(message.text)) && message.text.trim());
  const found = match[1].toLowerCase() === "first" ? candidates[0] : candidates.at(-1);
  if (!found) return role === "user" ? "I don’t have an earlier question from you in this chat." : "I don’t have an earlier question from me in this chat.";
  const owner = role === "user" ? "Your" : "My";
  const position = match[1].toLowerCase() === "previous" ? "last" : match[1].toLowerCase();
  return owner + " " + position + " " + match[2].toLowerCase() + " was “" + found.text + "”.";
}
