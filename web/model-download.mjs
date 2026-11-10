import { MODEL_BYTES, MODEL_FILE, MODEL_SOURCE } from "./model-settings.mjs";

export const CACHE_DIRECTORY = "jex-models";
const PART_BYTES = 16 * 1024 * 1024;

export function modelFetcher(fetchAsset) {
  let useModelHost = false;
  return async (url, options) => {
    if (!useModelHost) {
      const response = await fetchAsset(url, options);
      if (response.status !== 404) return response;
      await response.body?.cancel();
      useModelHost = true;
    }
    return fetchAsset(MODEL_SOURCE, { ...options, credentials: "omit" });
  };
}

// The pinned model host supports ranges. A local server may return the full file.
export async function transferModel(file, url, size, fetchPart, onProgress, partBytes = PART_BYTES) {
  let offset = file.getSize();
  if (offset > size) {
    file.truncate(0);
    offset = 0;
  }
  onProgress(offset);
  while (offset < size) {
    const end = Math.min(offset + partBytes, size) - 1;
    const response = await fetchPart(url, { headers: { Range: "bytes=" + offset + "-" + end } });
    let limit = end + 1;
    if (response.status === 200 && !response.headers.has("content-range")) {
      file.truncate(0);
      offset = 0;
      limit = size;
    } else if (response.status !== 206 ||
        response.headers.get("content-range") !== "bytes " + offset + "-" + end + "/" + size) {
      await response.body?.cancel();
      throw new Error("Unexpected model download response (HTTP " + response.status + ")");
    }
    if (!response.body) throw new Error("Model response has no data");
    const start = offset;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > limit || file.write(value, { at: offset }) !== value.byteLength) {
          throw new Error("Model download could not be saved");
        }
        offset += value.byteLength;
        onProgress(offset);
      }
      if (offset !== limit) throw new Error("Model download ended early");
      file.flush();
    } catch (error) {
      file.truncate(start);
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({ data: url }) => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: true });
      const handle = await directory.getFileHandle(MODEL_FILE, { create: true });
      const file = await handle.createSyncAccessHandle();
      try {
        let percent = -1;
        await transferModel(file, url, MODEL_BYTES, modelFetcher(fetch), loaded => {
          const next = Math.floor(loaded / MODEL_BYTES * 100);
          if (next === percent) return;
          percent = next;
          postMessage({ loaded });
        });
      } finally {
        file.close();
      }
      postMessage({ done: true });
    } catch (error) {
      postMessage({ error: error.message });
    }
  };
}
