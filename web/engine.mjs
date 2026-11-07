// The browser implementation of the Jex decoder. Model computation stays in a worker.
const [BOS, END, USER, JEX] = [1, 2, 3, 4];
const CONTROL_COUNT = 6;
const utf8 = new TextEncoder();

export class Tokenizer {
  constructor(spec) {
    this.pattern = new RegExp(spec.pattern, "gu");
    this.pieces = spec.pieces.map(piece => Uint8Array.from(piece));
    this.byteIds = new Uint32Array(256);
    this.pieces.forEach((piece, id) => {
      if (piece.length === 1) this.byteIds[piece[0]] = id;
    });
    this.merges = new Map(spec.merges.map(([left, right, id], rank) => [
      left * this.pieces.length + right, { rank, id },
    ]));
  }

  encode(text) {
    const tokens = [];
    const vocabSize = this.pieces.length;
    for (const part of text.matchAll(this.pattern)) {
      let ids = Array.from(utf8.encode(part[0]), byte => this.byteIds[byte]);
      while (ids.length > 1) {
        let best;
        let pair;
        for (let i = 0; i + 1 < ids.length; i++) {
          const key = ids[i] * vocabSize + ids[i + 1];
          const merge = this.merges.get(key);
          if (merge && (!best || merge.rank < best.rank)) {
            best = merge;
            pair = key;
          }
        }
        if (!best) break;
        const next = [];
        for (let i = 0; i < ids.length; i++) {
          if (i + 1 < ids.length && ids[i] * vocabSize + ids[i + 1] === pair) {
            next.push(best.id);
            i++;
          } else {
            next.push(ids[i]);
          }
        }
        ids = next;
      }
      tokens.push(...ids);
    }
    return tokens;
  }

  prompt(messages, budget) {
    const turns = messages.map(message => [
      message.role === "user" ? USER : JEX, ...this.encode(message.text), END,
    ]);
    const latest = turns.at(-1);
    const last = latest.length > budget - 2 ? [USER, ...latest.slice(-(budget - 3))] : latest;
    const kept = [last];
    let used = last.length + 2;
    for (let index = turns.length - 3; index >= 0; index -= 2) {
      const pair = turns.slice(index, index + 2);
      const length = pair[0].length + pair[1].length;
      if (used + length > budget) break;
      kept.unshift(...pair);
      used += length;
    }
    return [BOS, ...kept.flat(), JEX];
  }
}

function matmul(matrix, vector, output) {
  const { values, cols, scales } = matrix;
  let index = 0;
  for (let row = 0; row < output.length; row++) {
    let sum = 0;
    for (let col = 0; col < cols; col++) sum += values[index++] * vector[col];
    output[row] = sum * scales[row];
  }
}

function rms(x, weight, output) {
  let squares = 0;
  for (const value of x) squares += value * value;
  const inv = 1 / Math.sqrt(squares / x.length + 1e-5);
  for (let i = 0; i < x.length; i++) output[i] = x[i] * inv * weight[i];
}

export class Decoder {
  constructor(spec, buffer) {
    this.cfg = spec.config;
    const { width, heads, layers, hidden, context, vocab_size: vocab } = this.cfg;
    const tensors = {};
    for (const [name, { offset, shape }] of Object.entries(spec.tensors)) {
      const [rows, cols] = shape;
      const scales = new Float32Array(buffer, offset, rows);
      tensors[name] = cols
        ? { scales, cols, values: new Int8Array(buffer, offset + rows * 4, rows * cols) }
        : scales;
    }
    this.embed = tensors["embed.weight"];
    this.norm = tensors["norm.weight"];
    this.blocks = Array.from({ length: layers }, (_, index) => {
      const block = {};
      for (const name of ["attn_norm", "qkv", "attn_out", "ff_norm", "gate", "up", "down"]) {
        block[name] = tensors["blocks." + index + "." + name + ".weight"];
      }
      block.key = new Float32Array(context * width);
      block.value = new Float32Array(context * width);
      return block;
    });
    const half = width / heads / 2;
    this.cos = new Float32Array(context * half);
    this.sin = new Float32Array(context * half);
    for (let pos = 0; pos < context; pos++) {
      for (let i = 0; i < half; i++) {
        const angle = pos * (10000 ** (-i / half));
        this.cos[pos * half + i] = Math.cos(angle);
        this.sin[pos * half + i] = Math.sin(angle);
      }
    }
    this.x = new Float32Array(width);
    this.normal = new Float32Array(width);
    this.qkv = new Float32Array(3 * width);
    this.attention = new Float32Array(width);
    this.scores = new Float32Array(context);
    this.residual = new Float32Array(width);
    this.gate = new Float32Array(hidden);
    this.up = new Float32Array(hidden);
    this.logits = new Float32Array(vocab);
  }

  attend(block, position) {
    const { width, heads } = this.cfg;
    const size = width / heads;
    const key = block.key;
    const value = block.value;
    const qkv = this.qkv;
    const scores = this.scores;
    const att = this.attention;
    const scale = 1 / Math.sqrt(size);
    const posOffset = position * width;
    const angleOffset = position * size / 2;
    for (let head = 0; head < heads; head++) {
      const start = head * size;
      for (let i = 0; i < size; i += 2) {
        const offset = start + i;
        const c = this.cos[angleOffset + i / 2], s = this.sin[angleOffset + i / 2];
        const qe = qkv[offset], qo = qkv[offset + 1];
        const ke = qkv[width + offset], ko = qkv[width + offset + 1];
        qkv[offset] = qe * c - qo * s;
        qkv[offset + 1] = qe * s + qo * c;
        key[posOffset + offset] = ke * c - ko * s;
        key[posOffset + offset + 1] = ke * s + ko * c;
      }
      let max = -Infinity;
      for (let pos = 0; pos <= position; pos++) {
        const base = pos * width + start;
        let dot = 0;
        for (let i = 0; i < size; i++) dot += qkv[start + i] * key[base + i];
        scores[pos] = dot * scale;
        max = Math.max(max, scores[pos]);
      }
      let total = 0;
      for (let pos = 0; pos <= position; pos++) {
        scores[pos] = Math.exp(scores[pos] - max);
        total += scores[pos];
      }
      for (let i = 0; i < size; i++) {
        let sum = 0;
        for (let pos = 0; pos <= position; pos++) {
          sum += scores[pos] * value[pos * width + start + i];
        }
        att[start + i] = sum / total;
      }
    }
  }

  forward(token, position, readLogits = true) {
    const { width } = this.cfg;
    const { x, normal, qkv, residual, attention, gate, up, embed } = this;
    for (let i = 0; i < width; i++) x[i] = embed.values[token * width + i] * embed.scales[token];
    for (const block of this.blocks) {
      rms(x, block.attn_norm, normal);
      matmul(block.qkv, normal, qkv);
      block.value.set(qkv.subarray(2 * width), position * width);
      this.attend(block, position);
      matmul(block.attn_out, attention, residual);
      for (let i = 0; i < width; i++) x[i] += residual[i];
      rms(x, block.ff_norm, normal);
      matmul(block.gate, normal, gate);
      matmul(block.up, normal, up);
      for (let i = 0; i < gate.length; i++) gate[i] = gate[i] * up[i] / (1 + Math.exp(-gate[i]));
      matmul(block.down, gate, residual);
      for (let i = 0; i < width; i++) x[i] += residual[i];
    }
    if (readLogits) {
      rms(x, this.norm, normal);
      matmul(embed, normal, this.logits);
      return this.logits;
    }
  }
}

export function nextToken(logits, generated) {
  let best = END;
  const count = generated.length;
  const banned = new Set();
  for (let i = 0; i + 2 < count; i++) {
    if (generated[i] === generated[count - 2] && generated[i + 1] === generated[count - 1]) {
      banned.add(generated[i + 2]);
    }
  }
  for (let id = CONTROL_COUNT; id < logits.length; id++) {
    if (!banned.has(id) && logits[id] > logits[best]) best = id;
  }
  return best;
}

export { END };
