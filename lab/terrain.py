#!/usr/bin/env python3
"""The ground itself, read from EA's client files (~/UO/client): which tiles can be walked on.

    python3 lab/terrain.py Felucca 1165 3595 1225 3625        # an ASCII map of that rectangle
    python3 lab/terrain.py Felucca 1175 3610 --tile            # one tile: land, statics, flags

The map: '.' open ground, '=' a floor or road (a walkable surface), '~' water, '^' rock or
mountain, '#' something in the way (a tree, a wall, a rock). It is an approximation of the
server's movement rules (land and statics by height, as a walker 16 high would meet them), good
for laying out a training ground or reading a hunting spot, not for a pathfinder.

Files: map<N>LegacyMUL.uop (the land: 8x8 blocks of tile id and height), staidx<N>.mul and
statics<N>.mul (what stands on it), tiledata.mul (each tile's flags and height). Standard library only.
"""
import argparse
import os
import struct

CLIENT = os.path.expanduser(os.environ.get("UO_DATA_DIR", "~/UO/client"))
# Each facet's file number and size in tiles (Mondain's Legacy and later).
FACETS = {"Felucca": (0, 7168, 4096), "Trammel": (1, 7168, 4096), "Ilshenar": (2, 2304, 1600),
          "Malas": (3, 2560, 2048), "Tokuno": (4, 1448, 1448), "Ter Mur": (5, 1280, 4096)}
IMPASSABLE, WET, SURFACE, BRIDGE = 0x40, 0x80, 0x200, 0x400
BLOCK = 196  # a land block: 4 bytes of header and 64 tiles of (id, z)
UOP_CHUNK = 4096 * BLOCK  # the .uop holds the old .mul in pieces of 4096 blocks


def uop_hash(name):
    """The hash a .uop file stores its entries under (Bob Jenkins' lookup3, hashlittle2)."""
    s, m = name.encode(), 0xFFFFFFFF
    rot = lambda x, k: ((x << k) | (x >> (32 - k))) & m
    a = b = c = (0xDEADBEEF + len(s)) & m
    i = 0
    while len(s) - i > 12:
        a = (a + int.from_bytes(s[i:i + 4], "little")) & m
        b = (b + int.from_bytes(s[i + 4:i + 8], "little")) & m
        c = (c + int.from_bytes(s[i + 8:i + 12], "little")) & m
        a = (a - c) & m; a ^= rot(c, 4); c = (c + b) & m
        b = (b - a) & m; b ^= rot(a, 6); a = (a + c) & m
        c = (c - b) & m; c ^= rot(b, 8); b = (b + a) & m
        a = (a - c) & m; a ^= rot(c, 16); c = (c + b) & m
        b = (b - a) & m; b ^= rot(a, 19); a = (a + c) & m
        c = (c - b) & m; c ^= rot(b, 4); b = (b + a) & m
        i += 12
    if len(s) - i:
        tail = s[i:] + bytes(12 - (len(s) - i))
        a = (a + int.from_bytes(tail[0:4], "little")) & m
        b = (b + int.from_bytes(tail[4:8], "little")) & m
        c = (c + int.from_bytes(tail[8:12], "little")) & m
        c ^= b; c = (c - rot(b, 14)) & m
        a ^= c; a = (a - rot(c, 11)) & m
        b ^= a; b = (b - rot(a, 25)) & m
        c ^= b; c = (c - rot(b, 16)) & m
        a ^= c; a = (a - rot(c, 4)) & m
        b ^= a; b = (b - rot(a, 14)) & m
        c ^= b; c = (c - rot(b, 24)) & m
    return (b << 32) | c


def uop_entries(path):
    """{hash: (offset of the data, length)} of a .uop file."""
    out = {}
    with open(path, "rb") as f:
        magic, _version, _signature, nxt = struct.unpack("<IIIq", f.read(20))
        if magic != 0x50594D:
            raise ValueError(f"{path} is not a .uop file")
        while nxt:
            f.seek(nxt)
            count, nxt = struct.unpack("<iq", f.read(12))
            for _ in range(count):
                offset, header, compressed, _size, h, _adler, flag = struct.unpack("<qiiiQIh", f.read(34))
                if offset:
                    if flag:
                        raise ValueError(f"{path}: compressed entries are not read here")
                    out[h] = (offset + header, compressed)
    return out


class Tiledata:
    """Flags and heights of every land and static tile (the 64-bit flags of clients since 7.0.9)."""

    def __init__(self, path):
        with open(path, "rb") as f:
            data = f.read()
        self.land, self.statics = [], []
        pos = 0
        for _ in range(512):  # 32 land tiles a group: flags, texture, name
            pos += 4
            for _ in range(32):
                self.land.append(struct.unpack_from("<Q", data, pos)[0])
                pos += 30
        while pos + 4 + 32 * 41 <= len(data):  # 32 statics a group: flags, weight, layer, count, anim, hue, light, height, name
            pos += 4
            for _ in range(32):
                flags, height = struct.unpack_from("<Q", data, pos)[0], data[pos + 20]
                self.statics.append((flags, height))
                pos += 41


class Facet:
    def __init__(self, name, client=CLIENT):
        number, self.width, self.height = FACETS[name]
        self.tiledata = Tiledata(os.path.join(client, "tiledata.mul"))
        self.map_path = os.path.join(client, f"map{number}LegacyMUL.uop")
        entries = uop_entries(self.map_path)
        self.chunks = []
        for i in range((self.width // 8) * (self.height // 8) * BLOCK // UOP_CHUNK + 1):
            e = entries.get(uop_hash(f"build/map{number}legacymul/{i:08d}.dat"))
            if e:
                self.chunks.append(e)
        self.statics_path = os.path.join(client, f"statics{number}.mul")
        self.index_path = os.path.join(client, f"staidx{number}.mul")
        self._land, self._statics = {}, {}

    def _block(self, x, y):
        return (x >> 3) * (self.height >> 3) + (y >> 3)

    def land(self, x, y):
        """(tile id, z) of the land at x, y."""
        b = self._block(x, y)
        if b not in self._land:
            offset, _ = self.chunks[b * BLOCK // UOP_CHUNK]
            with open(self.map_path, "rb") as f:
                f.seek(offset + b * BLOCK % UOP_CHUNK)
                self._land[b] = f.read(BLOCK)
        cell = 4 + ((y & 7) * 8 + (x & 7)) * 3
        tile, z = struct.unpack_from("<Hb", self._land[b], cell)
        return tile, z

    def statics(self, x, y):
        """[(tile id, z)] of what stands on x, y."""
        b = self._block(x, y)
        if b not in self._statics:
            with open(self.index_path, "rb") as f:
                f.seek(b * 12)
                lookup, length, _ = struct.unpack("<iii", f.read(12))
            block = []
            if lookup >= 0 and length > 0:
                with open(self.statics_path, "rb") as f:
                    f.seek(lookup)
                    raw = f.read(length)
                for i in range(0, len(raw) - 6, 7):
                    tile, sx, sy, z, _hue = struct.unpack_from("<HBBbh", raw, i)
                    block.append((sx, sy, tile, z))
            self._statics[b] = block
        return [(t, z) for sx, sy, t, z in self._statics[b] if sx == (x & 7) and sy == (y & 7)]

    def kind(self, x, y):
        """'.' open, '=' a walkable surface, '~' water, '^' impassable land, '#' blocked by something on it."""
        tile, z = self.land(x, y)
        flags = self.tiledata.land[tile]
        floor = None
        blocked = False
        for t, sz in self.statics(x, y):
            sflags, height = self.tiledata.statics[t]
            top = sz + (height // 2 if sflags & BRIDGE else height)
            if sflags & SURFACE and not sflags & IMPASSABLE and top <= z + 16:
                floor = max(floor if floor is not None else top, top)
            elif sflags & IMPASSABLE and sz < z + 16 and top > z + 2:
                blocked = True
        if blocked:
            return "#"
        if floor is not None:
            return "="
        if flags & WET:
            return "~"
        if flags & IMPASSABLE:
            return "^"
        return "."


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("facet", choices=list(FACETS))
    ap.add_argument("x1", type=int)
    ap.add_argument("y1", type=int)
    ap.add_argument("x2", type=int, nargs="?")
    ap.add_argument("y2", type=int, nargs="?")
    ap.add_argument("--tile", action="store_true", help="one tile's land and statics with their flags")
    args = ap.parse_args()
    f = Facet(args.facet)
    if args.tile or args.x2 is None:
        tile, z = f.land(args.x1, args.y1)
        print(f"land 0x{tile:04X} z={z} flags 0x{f.tiledata.land[tile]:X}")
        for t, sz in f.statics(args.x1, args.y1):
            print(f"static 0x{t:04X} z={sz} flags 0x{f.tiledata.statics[t][0]:X} height {f.tiledata.statics[t][1]}")
        print("kind", f.kind(args.x1, args.y1))
        return
    print(f"{args.facet} x {args.x1}-{args.x2} (columns), y {args.y1}-{args.y2} (rows)")
    for y in range(args.y1, args.y2 + 1):
        print(f"{y:5} " + "".join(f.kind(x, y) for x in range(args.x1, args.x2 + 1)))


if __name__ == "__main__":
    main()
