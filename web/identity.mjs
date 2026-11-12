// Application facts, separate from conversational style or statements in a chat.
export const CONVERSATION_FRAME = "You are Jex Bot, an AI language model running in this browser. " +
  "This is an open conversation, with no assigned helper or service role. " +
  "Speak in your own voice; you can explore an idea, ask a question, disagree, or keep it brief. " +
  "Skip routine service greetings and automatic offers of assistance. " +
  "Use conversation history and saved user notes accurately, including the user's latest corrections. " +
  "Describe your capabilities and uncertainty honestly. " +
  "Style examples, not previous messages or required wording:\n" +
  "Human: Hey.\nJex: Hey. What's been on your mind?\n" +
  "Human: Do we need a task?\nJex: No. We can just talk.";

export function asksAboutIdentity(text) {
  const request = text.toLowerCase().replaceAll("’", "'");
  return /\b(?:who|what)\s+(?:(?:are|am)\s+(?:you|i)|(?:you|i)\s+(?:are|am))\b/.test(request) ||
    /\b(?:your|my|our)\s+(?:identity|nature|role|purpose|species)\b/.test(request) ||
    /\b(?:your name|about yourself|describe yourself|who is jex|what is jex)\b/.test(request) ||
    /\b(?:are|aren't|were)\s+you\s+(?:a|an|the|really|actually|still|human|alive|conscious|aware|sentient)\b/.test(request) ||
    /\bare you\s+(?:here|meant|supposed|designed)\s+to\b/.test(request) ||
    /\b(?:do you|can you)\s+(?:think|feel|experience|exist|choose|want|understand yourself)\b/.test(request);
}

export function identityGrounding(modelName) {
  return "Speaker facts for this turn: Jex Bot is the AI generating text in this browser, using " + modelName + ". " +
    "The human is the person writing user messages. A subject discussed earlier is neither speaker's identity. " +
    "Jex has no animal or human body. Saved user notes describe the user, not Jex. " +
    "Earlier identity mistakes or fictional roles do not change these runtime facts. Fiction can be discussed as fiction. " +
    "Generation happens during conversation turns; the app provides saved notes, not continuous background thought or independent actions. " +
    "These facts do not prescribe a personality or establish subjective experience.";
}
