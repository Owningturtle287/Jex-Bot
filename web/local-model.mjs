import { buildPrompt } from "./model-context.mjs";
import { CONTEXT_TOKENS, MODEL_BYTES, MODEL_FILE, MODEL_NAME, REPLY_TOKENS } from "./model-settings.mjs";

const modelURL = new URL("./model/" + MODEL_FILE, import.meta.url).href;
const runtime = new URL("./vendor/wllama-2.4.0/", import.meta.url);

export async function loadLocalModel({ allowDownload, onProgress }) {
  const { Wllama } = await import(new URL("index.js", runtime));
  const llama = new Wllama({
    "single-thread/wllama.wasm": new URL("single-thread/wllama.wasm", runtime).href,
    "multi-thread/wllama.wasm": new URL("multi-thread/wllama.wasm", runtime).href,
  }, { allowOffline: true, suppressNativeLog: true });
  try {
    async function findModel() {
      const models = await llama.modelManager.getModels();
      const cached = models.find(entry => entry.url === modelURL && entry.size === MODEL_BYTES);
      if (cached || !allowDownload) return cached;
      return llama.modelManager.downloadModel(modelURL, { progressCallback: onProgress });
    }
    const model = allowDownload && navigator.locks
      ? await navigator.locks.request("jex-download:" + modelURL, findModel)
      : await findModel();
    if (!model) return null;
    if (model.size !== MODEL_BYTES) {
      await model.remove();
      throw new Error("Incomplete model download");
    }
    await llama.loadModel(await model.open(), {
      n_ctx: CONTEXT_TOKENS, n_batch: 128, n_threads: Math.min(4, navigator.hardwareConcurrency || 1),
      n_gpu_layers: 0, seed: 42,
    });
    let previousPrompt = "";
    return {
      name: MODEL_NAME,
      close: () => llama.exit(),
      async reply(messages, signal, onText) {
        const prompt = await buildPrompt(messages, async text => (await llama.tokenize(text)).length);
        if (signal.aborted) return;
        // Reuse KV state only when there is new input to produce fresh logits.
        const useCache = !!previousPrompt && prompt.length > previousPrompt.length && prompt.startsWith(previousPrompt);
        previousPrompt = "";
        const decoder = new TextDecoder();
        await llama.createCompletion(prompt, {
          nPredict: REPLY_TOKENS,
          useCache,
          abortSignal: signal,
          sampling: { temp: 0.1, top_k: 20, top_p: 0.9, penalty_repeat: 1.08 },
          onNewToken(_id, bytes) {
            const text = decoder.decode(bytes, { stream: true });
            if (!signal.aborted && text) onText(text);
          },
        });
        const tail = decoder.decode();
        if (!signal.aborted && tail) onText(tail);
        if (!signal.aborted) previousPrompt = prompt;
      },
    };
  } catch (error) {
    await llama.exit().catch(() => {});
    throw error;
  }
}
