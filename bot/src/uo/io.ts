// Big-endian packet reading and writing.

const latin1 = new TextDecoder("latin1");

export class PacketReader {
  readonly data: Uint8Array;
  #view: DataView;
  pos: number;

  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  skip(n: number): this {
    this.pos += n;
    return this;
  }

  u8(): number {
    return this.#view.getUint8(this.pos++);
  }

  i8(): number {
    return this.#view.getInt8(this.pos++);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    const v = this.#view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    const v = this.#view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.#view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.#view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  /** Fixed-width latin1 field, cut at the first NUL. */
  fixedString(length: number): string {
    const bytes = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    const end = bytes.indexOf(0);
    return latin1.decode(end >= 0 ? bytes.subarray(0, end) : bytes);
  }

  /** NUL-terminated latin1 string. */
  nullString(): string {
    let end = this.pos;
    while (end < this.data.length && this.data[end] !== 0) {
      end++;
    }
    const s = latin1.decode(this.data.subarray(this.pos, end));
    this.pos = Math.min(end + 1, this.data.length);
    return s;
  }

  /** NUL-terminated UTF-16 string; big-endian unless `little`. */
  unicodeNull(little = false): string {
    let s = "";
    while (this.remaining >= 2) {
      const c = little ? this.#view.getUint16(this.pos, true) : this.#view.getUint16(this.pos);
      this.pos += 2;
      if (c === 0) {
        break;
      }
      s += String.fromCharCode(c);
    }
    return s;
  }
}

export class PacketWriter {
  #buf: Uint8Array;
  #view: DataView;
  #pos = 0;

  constructor(capacity = 64) {
    this.#buf = new Uint8Array(capacity);
    this.#view = new DataView(this.#buf.buffer);
  }

  #ensure(n: number): void {
    if (this.#pos + n <= this.#buf.length) {
      return;
    }
    const next = new Uint8Array(Math.max(this.#buf.length * 2, this.#pos + n));
    next.set(this.#buf);
    this.#buf = next;
    this.#view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.#ensure(1);
    this.#view.setUint8(this.#pos++, v & 0xff);
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    this.#ensure(2);
    this.#view.setUint16(this.#pos, v & 0xffff);
    this.#pos += 2;
    return this;
  }

  u32(v: number): this {
    this.#ensure(4);
    this.#view.setUint32(this.#pos, v >>> 0);
    this.#pos += 4;
    return this;
  }

  zeros(n: number): this {
    this.#ensure(n);
    this.#pos += n; // buffer is zero-initialised and never reused
    return this;
  }

  bytes(b: Uint8Array): this {
    this.#ensure(b.length);
    this.#buf.set(b, this.#pos);
    this.#pos += b.length;
    return this;
  }

  /** Fixed-width latin1 field, NUL padded (and truncated to fit). */
  fixedString(s: string, length: number): this {
    this.#ensure(length);
    for (let i = 0; i < length; i++) {
      this.#buf[this.#pos + i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
    }
    this.#pos += length;
    return this;
  }

  nullString(s: string): this {
    return this.fixedString(s, s.length + 1);
  }

  unicodeNull(s: string): this {
    for (let i = 0; i < s.length; i++) {
      this.u16(s.charCodeAt(i));
    }
    return this.u16(0);
  }

  /** The packet so far; with `variable`, bytes 1..2 get the total length. */
  finish(variable = false): Uint8Array {
    if (variable) {
      this.#view.setUint16(1, this.#pos);
    }
    return this.#buf.slice(0, this.#pos);
  }
}
