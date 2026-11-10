import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MODEL_BYTES, MODEL_FILE } from "../web/model-settings.mjs";

const root = new URL("../", import.meta.url);
const vendor = new URL("web/vendor/wllama-2.4.0/", root);
const upstream = new URL("node_modules/@wllama/wllama/", root);
const model = new URL("web/model/" + MODEL_FILE, root);
const modelURL = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_0.gguf";
const modelHash = "7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed";

for (const path of ["single-thread/", "multi-thread/"]) {
  await mkdir(new URL(path, vendor), { recursive: true });
}
for (const path of ["index.js", "single-thread/wllama.wasm", "multi-thread/wllama.wasm"]) {
  await copyFile(new URL("esm/" + path, upstream), new URL(path, vendor));
}
await copyFile(new URL("LICENCE", upstream), new URL("LICENSE", vendor));
await copyFile(new URL("node_modules/@huggingface/jinja/LICENSE", root), new URL("JINJA-LICENSE", vendor));

async function verify(file) {
  const info = await stat(file).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (info?.size !== MODEL_BYTES) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex") === modelHash;
}

if (!process.argv.includes("--runtime-only") && !await verify(model)) {
  const temporary = new URL(MODEL_FILE + ".part", model);
  try {
    if (process.env.JEX_MODEL_FILE) {
      await copyFile(process.env.JEX_MODEL_FILE, temporary);
    } else {
      console.log("Downloading and verifying the 429 MB Qwen model…");
      const { status, error } = spawnSync("curl", [
        "--fail", "--location", "--silent", "--show-error", "--retry", "3", "--max-time", "240",
        "--output", fileURLToPath(temporary), modelURL,
      ], { stdio: "inherit" });
      if (error || status !== 0) throw error ?? new Error("Model download failed");
    }
    if (!await verify(temporary)) throw new Error("Qwen model checksum or size mismatch");
    await rename(temporary, model);
  } finally {
    await rm(temporary, { force: true });
  }
}
