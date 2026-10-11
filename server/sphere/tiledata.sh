#!/bin/sh
# Writes the synthetic world's tiledata.mul: the 7.0.9+ (High Seas) layout, all zeros (every tile
# passable, no flags), except the entries the arena needs. The same layout and bytes as the
# synthetic data in server/Dockerfile (ModernUO), with more entries: ModernUO's clothes, hair and
# spellbooks set their layer in code, Sphere reads every item's layer from tiledata.
#
#   tiledata.sh <output file>
#
# Item entries follow 493,568 bytes of land data, 41 bytes each, with a 4-byte header before every
# block of 32. An entry starts with 8 bytes of flags; byte 9 is the layer of something worn, byte
# 20 the height, and the name follows it.
set -eu

out=${1:?usage: tiledata.sh <output file>}
head -c 3188736 /dev/zero > "$out"

entry() { echo $((493568 + ($1 / 32 + 1) * 4 + $1 * 41)); }
# put <offset> <printf format of the bytes>
put() { printf "$2" | dd of="$out" bs=1 seek="$1" conv=notrunc 2>/dev/null; }

# Item 0x0080, a stone wall block, gets its real flags: Wall 0x10, Impassable 0x40 and NoShoot
# 0x2000, 20 high. [NeoArena's obstacles block walking and line of sight as walls do.
off=$(entry $((0x0080)))
put "$off" '\120\040\000\000\000\000\000\000'
put $((off + 20)) '\024stone wall'

# Wearable (0x400000) and the layer, for what the bots wear or carry in hand: hex item id : layer
# (1 one hand, 2 two hands, 3 feet, 4 legs, 5 shirt, 6 head, 7 hands, 10 neck, 11 hair, 13 chest,
# 16 beard, 19 arms, 21 backpack, 22 robe, 23 skirt). Both graphics of a pair, since Scripts-X
# defines an item on one of them and ModernUO on either.
#   backpack                     Sphere saves the layer of what is worn only from 25 up and takes
#                                the rest from here when it loads the world: without it, every
#                                restart threw away the players' backpacks and all in them
#   weapons, shield, spellbook   katana, broadsword, longsword, kryss, war fork, dagger, halberd,
#                                bow, crossbow, heater shield, spellbook
#   leather armour               tunic, leggings, sleeves, gloves, gorget, cap
#   clothes                      robe, death shroud, wizard's hat, shirt, short pants, long skirt, shoes
#   hair and beards              the human styles a new character can pick
for spec in \
  e75:21 9b2:21 \
  13fe:1 13ff:1 f5e:1 f5f:1 f60:1 f61:1 1400:1 1401:1 1404:1 1405:1 f51:1 f52:1 \
  143e:2 143f:2 13b1:2 13b2:2 f4f:2 f50:2 1b76:2 1b77:2 efa:1 \
  13cc:13 13d3:13 13cb:4 13d2:4 13c5:19 13cd:19 13c6:7 13ce:7 13c7:10 1db9:6 1dba:6 \
  1f03:22 1f04:22 204e:22 1718:6 1517:5 152e:4 152f:4 1516:23 170f:3 1710:3 \
  203b:11 203c:11 203d:11 2044:11 2045:11 2046:11 2047:11 2048:11 2049:11 204a:11 \
  203e:16 203f:16 2040:16 2041:16 204b:16 204c:16 204d:16; do
  off=$(entry $((0x${spec%%:*})))
  put "$off" '\000\000\100\000\000\000\000\000'
  put $((off + 9)) "$(printf '\\%03o' "${spec##*:}")"
done
