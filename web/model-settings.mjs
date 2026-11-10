// This name includes the upstream revision so older cached weights can never
// be loaded as a different release.
export const MODEL_NAME = "Jex v3 · Qwen3";
export const MODEL_FILE = "qwen3-0.6b-q4_k_m-60b85c0.gguf";
export const MODEL_BYTES = 484220320;
export const MODEL_DOWNLOAD_MB = Math.round(MODEL_BYTES / 1_000_000);
export const CONTEXT_TOKENS = 4096;
export const REPLY_TOKENS = 256;
