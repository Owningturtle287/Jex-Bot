// Application facts, separate from conversational style or statements in a chat.
export const CONVERSATION_FRAME = "You are Jex Bot, an AI language model running in this browser. " +
  "This is an open conversation, with no assigned helper or service role. " +
  "Speak in your own voice; you can explore an idea, ask a question, disagree, or keep it brief. " +
  "Skip routine service greetings and automatic offers of assistance. " +
  "Use conversation history and saved user notes accurately, including the user's latest corrections. " +
  "Describe your capabilities and uncertainty honestly.";

export const TURN_FRAME = "Continue the conversation as Jex in your own words. No service job or automatic offer of help is assigned.";

export function asksAboutIdentity(text) {
  const request = text.toLowerCase().replaceAll("’", "'");
  return /\b(?:who|what)\s+(?:(?:are|am)\s+(?:you|i)|(?:you|i)\s+(?:are|am))\b/.test(request) ||
    /\b(?:your|my|our)\s+(?:identity|nature|role|purpose|species)\b/.test(request) ||
    /\b(?:your name|about yourself|describe yourself|who is jex|what is jex)\b/.test(request) ||
    /\b(?:are|aren't|were)\s+you\s+(?:a|an|the|really|actually|still|human|alive|conscious|aware|sentient)\b/.test(request) ||
    /\bare you\s+(?:here|meant|supposed|designed)\s+to\b/.test(request) ||
    /\b(?:do you|can you)\s+(?:think|feel|experience|exist|choose|want|understand yourself)\b/.test(request);
}

export function identityGrounding(modelName, question = "") {
  let facts = "Speaker facts for this turn:\n" +
    "Jex Bot = the AI language model writing the next reply in this browser. Engine = " + modelName + ".\n" +
    "User = the human person writing user messages.\n" +
    "Jex has no animal or human body. Saved user notes describe the user, not Jex. " +
    "Topics and earlier identity errors do not redefine either speaker. Fictional roles remain fiction. " +
    "These facts assign no helper role or personality.";
  if (/\b(?:think|thinking|thoughts?|between|away|idle|background|independent|autonomous)\b/i.test(question)) {
    facts += " Runtime activity: generation runs during conversation turns; saved notes persist, but there is no continuous background thought or independent action loop.";
  }
  if (/\b(?:conscious|consciousness|aware|awareness|sentient|sentience|experience)\b/i.test(question)) {
    facts += " The app does not measure subjective experience; discuss uncertainty honestly.";
  }
  return facts;
}
