import { buildPrompt, START_ASSISTANT } from "./model-context.mjs";
import { CACHE_DIRECTORY } from "./model-download.mjs";
import { CONTEXT_TOKENS, MODEL_BYTES, MODEL_FILE, MODEL_NAME, REPLY_TOKENS } from "./model-settings.mjs";

const modelURL = new URL("./model/" + MODEL_FILE, import.meta.url).href;
const runtime = new URL("./vendor/wllama-2.3.7/", import.meta.url);

function ignoreMissing(error) {
  if (error.name !== "NotFoundError") throw error;
}

function downloadModel(onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./model-download.mjs", import.meta.url), { type: "module" });
    const fail = error => {
      worker.terminate();
      reject(new Error(error));
    };
    worker.onerror = event => fail(event.message || "Model download worker failed");
    worker.onmessage = ({ data }) => {
      if (data.error) fail(data.error);
      else if (data.done) {
        worker.terminate();
        resolve();
      } else {
        onProgress?.(data);
      }
    };
    worker.postMessage(modelURL);
  });
}

async function openWeights(llama, allowDownload, onProgress) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: allowDownload }).catch(ignoreMissing);
  const handle = await directory?.getFileHandle(MODEL_FILE).catch(ignoreMissing);
  const file = await handle?.getFile();
  if (file?.size === MODEL_BYTES) return [file];

  // Reuse a complete download from the original v3 release.
  const cached = (await llama.modelManager.getModels()).find(entry => entry.url === modelURL && entry.size === MODEL_BYTES);
  if (cached) return cached.open();
  if (!allowDownload) return null;
  await downloadModel(onProgress);
  const downloaded = await (await directory.getFileHandle(MODEL_FILE)).getFile();
  if (downloaded.size !== MODEL_BYTES) throw new Error("Incomplete model download");
  return [downloaded];
}

export async function loadLocalModel({ allowDownload, onProgress, onStatus }) {
  const { Wllama } = await import(new URL("index.js", runtime));
  const llama = new Wllama({
    "single-thread/wllama.wasm": new URL("single-thread/wllama.wasm", runtime).href,
    "multi-thread/wllama.wasm": new URL("multi-thread/wllama.wasm", runtime).href,
  }, {
    allowOffline: true,
    logger: { debug() {}, log() {}, warn: console.warn, error: console.error },
  });
  let stage = "prepare";
  try {
    const open = () => openWeights(llama, allowDownload, onProgress);
    const files = allowDownload && navigator.locks
      ? await navigator.locks.request("jex-download:" + modelURL, open)
      : await open();
    if (!files) return null;
    stage = "startup";
    onStatus?.("starting");
    await llama.loadModel(files, {
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
        const useCache = !!previousPrompt && prompt.length > previousPrompt.length &&
          prompt.startsWith(previousPrompt.slice(0, -START_ASSISTANT.length));
        previousPrompt = "";
        const decoder = new TextDecoder();
        await llama.createCompletion(prompt, {
          nPredict: REPLY_TOKENS,
          useCache,
          abortSignal: signal,
          sampling: { temp: 0.7, top_k: 20, top_p: 0.8, penalty_repeat: 1.08 },
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
    const failure = new Error(error.message || "Jex model setup failed", { cause: error });
    failure.stage = stage;
    throw failure;
  }
}
