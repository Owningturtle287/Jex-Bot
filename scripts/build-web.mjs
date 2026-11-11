import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MODEL_BYTES, MODEL_DOWNLOAD_MB, MODEL_FILE, MODEL_SOURCE } from "../web/model-settings.mjs";

const root = new URL("../", import.meta.url);
const vendor = new URL("web/vendor/wllama-2.3.7/", root);
const upstream = new URL("node_modules/@wllama/wllama/", root);
const modelDirectory = new URL(process.argv.includes("--cdn-model") ? "node_modules/.cache/jex/" : "web/model/", root);
const model = new URL(MODEL_FILE, modelDirectory);
const modelHash = "9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14";

for (const path of ["single-thread/", "multi-thread/"]) {
  await mkdir(new URL(path, vendor), { recursive: true });
}
for (const path of ["index.js", "single-thread/wllama.wasm", "multi-thread/wllama.wasm"]) {
  await copyFile(new URL("esm/" + path, upstream), new URL(path, vendor));
}
await copyFile(new URL("LICENCE", upstream), new URL("LICENSE", vendor));

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
  await mkdir(modelDirectory, { recursive: true });
  const temporary = new URL(MODEL_FILE + ".part", model);
  try {
    if (process.env.JEX_MODEL_FILE) {
      await copyFile(process.env.JEX_MODEL_FILE, temporary);
    } else {
      console.log("Downloading and verifying the " + MODEL_DOWNLOAD_MB + " MB Qwen model…");
      const { status, error } = spawnSync("curl", [
        "--fail", "--location", "--silent", "--show-error", "--retry", "3", "--max-time", "240",
        "--output", fileURLToPath(temporary), MODEL_SOURCE,
      ], { stdio: "inherit" });
      if (error || status !== 0) throw error ?? new Error("Model download failed");
    }
    if (!await verify(temporary)) throw new Error("Qwen model checksum or size mismatch");
    await rename(temporary, model);
  } finally {
    await rm(temporary, { force: true });
  }
}
