import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function memoryTypes(bytes) {
  let offset = 8; // WebAssembly magic and version.
  const types = [];
  const number = () => {
    let result = 0;
    let scale = 1;
    let byte;
    do {
      byte = bytes[offset++];
      result += (byte & 127) * scale;
      scale *= 128;
    } while (byte & 128);
    return result;
  };
  const name = () => {
    const length = number();
    offset += length;
  };
  const memory = () => {
    const flags = number();
    number(); // Initial memory pages.
    if (flags & 1) number(); // Maximum memory pages, if present.
    types.push(flags);
  };
  while (offset < bytes.length) {
    const section = bytes[offset++];
    const length = number();
    const end = offset + length;
    if (section === 2) { // Imports include the runtime's WebAssembly memory.
      const imports = number();
      for (let index = 0; index < imports; index++) {
        name();
        name();
        const kind = bytes[offset++];
        if (kind === 0) {
          number(); // Function type index.
        } else {
          assert.equal(kind, 2, "Review new runtime import types before upgrading");
          memory();
        }
      }
    } else if (section === 5) { // Single-thread builds define their own memory.
      const count = number();
      for (let index = 0; index < count; index++) memory();
    }
    offset = end;
  }
  return types;
}

for (const build of ["single-thread", "multi-thread"]) {
  test(build + " runtime uses 32-bit memory for Safari compatibility", async () => {
    const file = new URL("../node_modules/@wllama/wllama/esm/" + build + "/wllama.wasm", import.meta.url);
    const types = memoryTypes(await readFile(file));
    assert.equal(types.length, 1, "Expected one WebAssembly memory");
    assert.equal(types[0] & 4, 0, "Memory64 is unsupported on Safari");
  });
}
