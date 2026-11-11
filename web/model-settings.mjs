// This name includes the upstream revision so older cached weights can never
// be loaded as a different release.
export const MODEL_NAME = "Jex v4 · Standard";
export const MODEL_FILE = "qwen3-0.6b-q4_k_m-60b85c0.gguf";
export const MODEL_SOURCE = "https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/60b85c0e3d8fe0f6474f406922a26d12aca4550d/Qwen_Qwen3-0.6B-Q4_K_M.gguf";
export const MODEL_BYTES = 484220320;
export const MODEL_DOWNLOAD_MB = Math.round(MODEL_BYTES / 1_000_000);
export const CONTEXT_TOKENS = 4096;
export const REPLY_TOKENS = 1536;

export const MODELS = {
  local: {
    id: "local", name: MODEL_NAME, label: "Jex v4", engine: "Qwen3-0.6B", parameters: "0.6B",
    file: MODEL_FILE, source: MODEL_SOURCE, bytes: MODEL_BYTES, thinkingTemplate: true,
  },
  strong: {
    id: "strong", name: "Jex v4 · Stronger", label: "Jex Stronger", engine: "Qwen2.5-1.5B-Instruct", parameters: "1.5B",
    file: "qwen2.5-1.5b-q4_k_m-91cad51.gguf",
    source: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    bytes: 1117320736, thinkingTemplate: false,
  },
};
