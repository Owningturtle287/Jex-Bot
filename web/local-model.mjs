import { buildPrompt, generationPrefix } from "./model-context.mjs";
import { CACHE_DIRECTORY } from "./model-download.mjs";
import { CONTEXT_TOKENS, MODELS, REPLY_TOKENS } from "./model-settings.mjs";

const runtime = new URL("./vendor/wllama-2.3.7/", import.meta.url);

function ignoreMissing(error) {
  if (error.name !== "NotFoundError") throw error;
}

function downloadModel(model, modelURL, onProgress) {
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
    worker.postMessage({ modelId: model.id, url: modelURL });
  });
}

async function openWeights(llama, model, modelURL, allowDownload, onProgress) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: allowDownload }).catch(ignoreMissing);
  const handle = await directory?.getFileHandle(model.file).catch(ignoreMissing);
  const file = await handle?.getFile();
  if (file?.size === model.bytes) return [file];

  // Reuse a complete download from the original v3 release.
  const cached = (await llama.modelManager.getModels()).find(entry => entry.url === modelURL && entry.size === model.bytes);
  if (cached) return cached.open();
  if (!allowDownload) return null;
  await downloadModel(model, modelURL, onProgress);
  const downloaded = await (await directory.getFileHandle(model.file)).getFile();
  if (downloaded.size !== model.bytes) throw new Error("Incomplete model download");
  return [downloaded];
}

export async function loadLocalModel({ modelId = "local", allowDownload, onProgress, onStatus }) {
  const model = MODELS[modelId];
  if (!model) throw new Error("Unknown model");
  const modelURL = new URL("./model/" + model.file, import.meta.url).href;
  const prefix = generationPrefix(model.thinkingTemplate);
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
    const open = () => openWeights(llama, model, modelURL, allowDownload, onProgress);
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
      name: model.name,
      close: () => llama.exit(),
      async reply(messages, signal, onText, memories = []) {
        const prompt = await buildPrompt(
          messages, async text => (await llama.tokenize(text)).length,
          CONTEXT_TOKENS - REPLY_TOKENS - 8,
          { memories, modelName: model.engine, prefix },
        );
        if (signal.aborted) return;
        // Reuse KV state only when there is new input to produce fresh logits.
        const useCache = !!previousPrompt && prompt.length > previousPrompt.length &&
          prompt.startsWith(previousPrompt.slice(0, -prefix.length));
        previousPrompt = "";
        const decoder = new TextDecoder();
        await llama.createCompletion(prompt, {
          nPredict: REPLY_TOKENS,
          useCache,
          abortSignal: signal,
          sampling: { temp: 0.4, top_k: 20, top_p: 0.85, penalty_repeat: 1.05 },
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
