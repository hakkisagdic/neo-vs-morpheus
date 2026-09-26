import { describe, expect, it } from "vitest";
import { HuffmanDecoder, huffmanCompress } from "../src/uo/huffman.ts";

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

describe("huffman", () => {
  it("round-trips every byte value", () => {
    const packet = Uint8Array.from({ length: 256 }, (_, i) => i);
    const [chunk] = new HuffmanDecoder().push(huffmanCompress(packet));
    expect(chunk).toEqual(packet);
  });

  it("splits a stream back into its packets, across arbitrary socket reads", () => {
    const packets = [
      Uint8Array.of(0x55),
      Uint8Array.of(0x22, 0x01, 0x01),
      Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff),
      Uint8Array.of(0x73, 0x00),
    ];
    const stream = concat(packets.map(huffmanCompress));
    const decoder = new HuffmanDecoder();
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 5) {
      chunks.push(...decoder.push(stream.subarray(i, i + 5)));
    }
    expect(chunks).toEqual(packets);
  });

  it("packs codes MSB-first and pads the terminal symbol to a byte", () => {
    // 0x55 is 0x088 in 9 bits, then the terminal 0x00D in 4: 010001000 1101 000
    expect(huffmanCompress(Uint8Array.of(0x55))).toEqual(Uint8Array.of(0x44, 0x68));
  });
});
