// Packet lengths by id for a 7.0.x client, from ClassicUO's PacketsTable with its
// version adjustments applied for 7.0.9.0+ (HS) and 7.0.64.0+.
// -1 = variable length: a big-endian u16 total length follows the id.

// prettier-ignore
const BASE: readonly number[] = [
  104, 5, 7, -1, 2, 5, 5, 7, 14, 5, 11, 266, -1, 3, -1, 61,
  215, -1, -1, 10, 6, 9, 1, -1, -1, -1, -1, 37, -1, 5, 4, 8,
  19, 8, 3, 26, 7, 20, 5, 2, 5, 1, 5, 2, 2, 17, 15, 10,
  5, 1, 2, 2, 10, 653, -1, 8, 7, 9, -1, -1, -1, 2, 37, -1,
  201, -1, -1, 553, 713, 5, -1, 11, 73, 93, 5, 9, -1, -1, 6, 2,
  -1, -1, -1, 2, 12, 1, 11, 110, 106, -1, -1, 4, 2, 73, -1, 49,
  5, 9, 15, 13, 1, 4, -1, 21, -1, -1, 3, 9, 19, 3, 14, -1,
  28, -1, 5, 2, -1, 35, 16, 17, -1, 9, -1, 2, -1, 13, 2, -1,
  62, -1, 2, 39, 69, 2, -1, -1, 66, -1, -1, -1, 11, -1, -1, -1,
  19, 65, -1, 99, -1, 9, -1, 2, -1, 26, -1, 258, 309, 51, -1, -1,
  3, 9, 9, 9, 149, -1, -1, 4, -1, -1, 5, -1, -1, -1, -1, 13,
  -1, -1, -1, -1, -1, 64, 9, -1, -1, 3, 6, 9, 3, -1, -1, -1,
  36, -1, -1, -1, 6, 203, 1, 49, 2, 6, 6, 7, -1, 1, -1, 78,
  -1, 2, 25, -1, -1, -1, -1, -1, -1, 268, -1, -1, 9, -1, -1, -1,
  -1, -1, 10, -1, -1, -1, 5, 12, 13, 75, 3, -1, -1, -1, 10, 21,
  -1, 9, 25, 26, -1, 21, -1, -1, 106, -1, -1, -1, -1, -1, -1, -1,
];

const lengths = Int16Array.from(BASE);
Object.assign(lengths, {
  [0x00]: 0x6a, [0x08]: 0x0f, [0x0b]: 0x07, [0x16]: -1, [0x24]: 0x09, [0x25]: 0x15,
  [0x31]: -1, [0x99]: 0x1e, [0xb9]: 0x05, [0xba]: 0x0a, [0xe1]: -1, [0xe3]: -1,
  [0xe6]: 0x05, [0xe7]: 0x0c, [0xe8]: 0x0d, [0xe9]: 0x4b, [0xea]: 0x03, [0xee]: 0x0a,
  [0xef]: 0x15, [0xf1]: 0x09, [0xf2]: 0x19, [0xf3]: 0x1a, [0xfa]: 0x01, [0xfb]: 0x02,
});

/** Total length of the packet starting at `data[offset]`, or 0 if not enough bytes to tell. */
export function packetLength(data: Uint8Array, offset: number): number {
  const fixed = lengths[data[offset]];
  if (fixed > 0) {
    return fixed;
  }
  if (data.length - offset < 3) {
    return 0;
  }
  return (data[offset + 1] << 8) | data[offset + 2];
}
