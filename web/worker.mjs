import { Decoder, END, Tokenizer, nextToken } from "./engine.mjs";

const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
let running = false;
let canceled = false;

async function fetchAsset(name) {
  const response = await fetch(new URL("./model/" + name, import.meta.url));
  if (!response.ok) throw new Error("Model download failed");
  return response;
}

async function initialize() {
  const spec = await (await fetchAsset("model.json")).json();
  if (spec.format !== 1) throw new Error("Unsupported model format");
  const chunks = await Promise.all(spec.weights.map(async name => (await fetchAsset(name)).arrayBuffer()));
  const bytes = new Uint8Array(spec.bytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.length) throw new Error("Incomplete model download");
  if (crypto.subtle) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
    if (hex !== spec.sha256) throw new Error("Model checksum mismatch");
  }
  return { name: spec.name, decoder: new Decoder(spec, bytes.buffer), tokenizer: new Tokenizer(spec.tokenizer) };
}

const model = initialize();
model.then(({ name }) => postMessage({ type: "ready", name }), () => postMessage({ type: "unavailable" }));

self.onmessage = async ({ data }) => {
  if (data.type === "stop") {
    canceled = true;
    return;
  }
  if (data.type !== "chat" || running) return;
  running = true;
  canceled = false;
  try {
    const { decoder, tokenizer } = await model;
    const maxNew = Math.min(112, Math.floor(decoder.cfg.context / 2));
    const prompt = tokenizer.prompt(data.messages, decoder.cfg.context - maxNew);
    let logits;
    for (let position = 0; position < prompt.length && !canceled; position++) {
      logits = decoder.forward(prompt[position], position, position === prompt.length - 1);
      if (position % 12 === 11) await yieldToBrowser();
    }
    const generated = [];
    const stream = new TextDecoder();
    for (let step = 0; step < maxNew && !canceled; step++) {
      const id = nextToken(logits, generated);
      if (id === END) break;
      generated.push(id);
      const text = stream.decode(tokenizer.pieces[id], { stream: true });
      if (text) postMessage({ type: "delta", text, id: data.id });
      logits = decoder.forward(id, prompt.length + step);
      if (step % 4 === 3) await yieldToBrowser();
    }
    const rest = stream.decode();
    if (rest && !canceled) postMessage({ type: "delta", text: rest, id: data.id });
    postMessage({ type: "done", canceled, id: data.id });
  } catch {
    postMessage({ type: "error", id: data.id });
  } finally {
    running = false;
  }
};
