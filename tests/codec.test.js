import { describe, it, expect } from "vitest";
import { gzip, gunzip, toBase64, fromBase64, encodeDocument, decodeDocument } from "../src/client/persistence/codec.js";
import { chunk, MIN_CHUNK_CHARS } from "../src/client/persistence/chunker.js";
import { createHash } from "node:crypto";

const FIVE_MB = 5 * 1024 * 1024;

/** The same deterministic xorshift32 buffer the gate 3 harness generates. */
function makeBuffer(length, seed) {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("codec round trip", () => {
  it("survives gzip -> base64 -> chunk -> reassemble -> decode -> gunzip at 5 MB", async () => {
    const source = makeBuffer(FIVE_MB, 0x5eed1e);
    const before = sha256(source);

    const compressed = await gzip(source);
    const base64 = toBase64(compressed);
    const pieces = chunk(base64, MIN_CHUNK_CHARS);
    expect(pieces.length).toBeGreaterThan(50);

    const restored = await gunzip(fromBase64(pieces.join("")));
    expect(restored.length).toBe(FIVE_MB);
    expect(sha256(restored)).toBe(before);
  }, 120000);

  it("base64 round-trips 5 MB without a stack overflow", () => {
    const source = makeBuffer(FIVE_MB, 0xabcdef);
    const text = toBase64(source);
    const back = fromBase64(text);
    expect(back.length).toBe(source.length);
    expect(sha256(back)).toBe(sha256(source));
  }, 120000);

  it("matches Node's own base64 encoding exactly", () => {
    const source = makeBuffer(200000, 7);
    expect(toBase64(source)).toBe(Buffer.from(source).toString("base64"));
  });

  it("encodes windows that concatenate correctly at every boundary", () => {
    // A window that is not a whole number of 3-byte groups would corrupt the
    // join; these lengths straddle the 32760-byte window on purpose.
    for (const length of [0, 1, 2, 3, 32759, 32760, 32761, 65521]) {
      const source = makeBuffer(length, length + 1);
      expect(toBase64(source), `length ${length}`).toBe(Buffer.from(source).toString("base64"));
      expect(Array.from(fromBase64(toBase64(source))), `length ${length}`).toEqual(Array.from(source));
    }
  });

  it("gzip actually compresses repetitive data and gunzip reverses it", async () => {
    const source = new TextEncoder().encode("keystone".repeat(20000));
    const compressed = await gzip(source);
    expect(compressed.length).toBeLessThan(source.length / 10);
    expect(sha256(await gunzip(compressed))).toBe(sha256(source));
  });

  it("encodeDocument / decodeDocument round-trip a Build-shaped object", async () => {
    const doc = {
      schema: 1,
      meta: { id: "b_7Hq2kd", name: "Hill Country Build 1", updated: "2026-09-19T00:00:00Z" },
      walls: Array.from({ length: 500 }, (_, i) => ({ id: `w_${i}`, a: [i, 0], b: [i, 10] })),
    };
    expect(await decodeDocument(await encodeDocument(doc))).toEqual(doc);
  });
});
