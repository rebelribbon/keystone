import { describe, it, expect } from "vitest";
import { chunk, nextChunkSize, START_CHUNK_CHARS, MIN_CHUNK_CHARS } from "../src/client/persistence/chunker.js";

describe("nextChunkSize — the halving ladder", () => {
  it("walks 1.5 MB -> 750 KB -> 375 KB -> 187 KB -> 100 KB and then throws", () => {
    const ladder = [START_CHUNK_CHARS];
    let size = START_CHUNK_CHARS;
    for (let i = 0; i < 10; i++) {
      let next;
      try {
        next = nextChunkSize(size);
      } catch {
        break;
      }
      ladder.push(next);
      size = next;
    }
    expect(ladder).toEqual([1500000, 750000, 375000, 187500, 100000]);
    expect(() => nextChunkSize(MIN_CHUNK_CHARS)).toThrow(/minimum chunk size/i);
  });

  it("clamps to the floor rather than halving past it", () => {
    expect(nextChunkSize(187500)).toBe(MIN_CHUNK_CHARS);
    expect(nextChunkSize(MIN_CHUNK_CHARS + 1)).toBe(MIN_CHUNK_CHARS);
  });

  it("rejects a nonsensical current size", () => {
    expect(() => nextChunkSize(0)).toThrow();
    expect(() => nextChunkSize(-1)).toThrow();
    expect(() => nextChunkSize(NaN)).toThrow();
  });
});

describe("chunk", () => {
  it("reassembles losslessly with a non-multiple final chunk", () => {
    const text = "abcdefghij";
    const pieces = chunk(text, 4);
    expect(pieces).toEqual(["abcd", "efgh", "ij"]);
    expect(pieces.join("")).toBe(text);
  });

  it("reassembles losslessly at an exact multiple", () => {
    const pieces = chunk("abcdefgh", 4);
    expect(pieces).toEqual(["abcd", "efgh"]);
    expect(pieces.join("")).toBe("abcdefgh");
  });

  it("handles empty input and rejects a bad size", () => {
    expect(chunk("", 10)).toEqual([]);
    expect(() => chunk("abc", 0)).toThrow();
  });

  it("chunks a realistic base64 payload at the floor size", () => {
    const text = "x".repeat(MIN_CHUNK_CHARS * 3 + 17);
    const pieces = chunk(text, MIN_CHUNK_CHARS);
    expect(pieces).toHaveLength(4);
    expect(pieces[3]).toHaveLength(17);
    expect(pieces.join("")).toBe(text);
  });
});
