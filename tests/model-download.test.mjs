import assert from "node:assert/strict";
import test from "node:test";
import { transferModel } from "../web/model-download.mjs";

function memoryFile(initial = []) {
  const bytes = [...initial];
  return {
    bytes,
    getSize: () => bytes.length,
    truncate: size => { bytes.length = size; },
    write(value, { at }) {
      bytes.splice(at, value.length, ...value);
      return value.length;
    },
    flush() {},
  };
}

function partial(bytes, range) {
  return new Response(Uint8Array.from(bytes), { status: 206, headers: { "Content-Range": range } });
}

test("resumes after a failed range without requesting saved bytes again", async () => {
  const file = memoryFile();
  const requests = [];
  const url = "https://example.test/model.gguf";
  const fetchPart = async (_url, { headers }) => {
    requests.push(headers.Range);
    return headers.Range === "bytes=0-1"
      ? partial([1, 2], "bytes 0-1/4")
      : partial(requests.length === 2 ? [3] : [3, 4], "bytes 2-3/4");
  };
  await assert.rejects(transferModel(file, url, 4, fetchPart, () => {}, 2), /ended early/);
  assert.deepEqual(file.bytes, [1, 2]);
  const progress = [];
  await transferModel(file, url, 4, fetchPart, count => progress.push(count), 2);
  assert.deepEqual(requests, ["bytes=0-1", "bytes=2-3", "bytes=2-3"]);
  assert.deepEqual(file.bytes, [1, 2, 3, 4]);
  assert.deepEqual(progress, [2, 4]);
});

test("accepts a full response from a server without range support", async () => {
  const file = memoryFile([9, 9]);
  await transferModel(file, "https://example.test/model.gguf", 4,
    async () => new Response(Uint8Array.of(1, 2, 3, 4)), () => {}, 2);
  assert.deepEqual(file.bytes, [1, 2, 3, 4]);
});

test("rejects an HTTP error or a response for the wrong range", async () => {
  const file = memoryFile([1, 2]);
  for (const response of [new Response("Error", { status: 503 }), partial([1, 2], "bytes 0-1/4")]) {
    await assert.rejects(transferModel(file, "https://example.test/model.gguf", 4,
      async () => response, () => {}, 2), /Unexpected model download response/);
    assert.deepEqual(file.bytes, [1, 2]);
  }
});
