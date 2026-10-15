"""Tests for looting by value: reading item values out of ModernUO's source (lab/itemvalues.py) and choosing
what to take from a corpse (lab/loot.py). No game, no network:
python3 -m unittest discover -s lab -p "test_*.py\""""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import itemvalues  # noqa: E402
import loot  # noqa: E402

GEMS = """
using ModernUO.Serialization;

namespace Server.Items
{
    [SerializationGenerator(0, false)]
    [Flippable(0xF21, 0xF22)]
    public partial class StarSapphire : Item
    {
        [Constructible]
        public StarSapphire(int amount = 1) : base(0xF21)
        {
            Stackable = true; // a "string { with a brace" would not count
            Amount = amount;
        }

        public override double DefaultWeight => 0.1;
    }

    public abstract partial class BaseCoin : Item
    {
        public BaseCoin(int itemID) : base(itemID) { }

        public override double DefaultWeight => Core.ML ? 0.02 / 3 : 0.02;

        public override int LabelNumber => 1041243; // a contract of employment
    }

    public partial class Doubloon : BaseCoin
    {
        public Doubloon() : base(0xEED, 0x47E) { }
    }

    public partial class Trinket : Item
    {
        public Trinket() : base(Utility.RandomList(0x1F14, 0x1F15)) => Hue = 0x21;

        public override string DefaultName => "a shiny trinket";

        private class InternalTarget : Target
        {
            public override double DefaultWeight => 99.0;
        }
    }
}
"""

SHOP = """
namespace Server.Mobiles
{
    public class SBGems : SBInfo
    {
        public class InternalBuyInfo : List<GenericBuyInfo>
        {
            public InternalBuyInfo()
            {
                Add(new GenericBuyInfo(typeof(StarSapphire), 125, 20, 0xF21, 0));
                Add(new GenericBuyInfo("1041243", typeof(Trinket), 1252, 20, 0x14F0, 0));
                Add(new BeverageBuyInfo(typeof(Pitcher), BeverageType.Ale, 11, 20, 0x1F95, 0));
                Add(new AnimalBuyInfo(1, "a horse", typeof(Horse), 550, 10, 204, 0));

                if (!Core.AOS)
                {
                    Add(new GenericBuyInfo(typeof(StarSapphire), 99, 20, 0xF21, 0));
                }

                var types = Loot.RegularScrollTypes;
                var circles = 2;

                for (var i = 0; i < circles * 8 && i < types.Length; ++i)
                {
                    Add(new GenericBuyInfo(types[i], 12 + i / 8 * 10, 20, 0x1F2E + i, 0));
                }
            }
        }

        public class InternalSellInfo : GenericSellInfo
        {
            public InternalSellInfo()
            {
                Add(typeof(StarSapphire), 62);
                /* Add(typeof(Trinket), 5000); */

                if (Core.SA)
                {
                    Add(typeof(Trinket), 900);
                }
                else
                {
                    Add(typeof(Trinket), 600);
                }

                var types = Loot.RegularScrollTypes;

                for (var i = 0; i < types.Length; ++i)
                {
                    Add(types[i], (i / 8 + 2) * 2);
                }
            }
        }
    }
}
"""

LISTING = """[16:33:20.842] [CMD] container 0x4004F3E7
[16:33:20.846] [CONTAINER] 0x4004F3E7 A Skeletal Corpse x56:
[16:33:20.846]   [item]      0x4004F1E2 31 Gold Coin x31
[16:33:20.846]   [item]      0x4004F1E3 Bone Gloves
[16:33:20.846]   [item]      0x4004F1E4 3 Star Sapphire x3
[16:33:20.846]   [item]      0x4004F1E5 Paralyze
[16:33:20.846]   [item]      0x4004F1E6 12 Black Pearl x12
[16:33:20.846]   [item]      0x4004F1E7 Platemail Gorget
[16:33:20.846]   [item]      0x4004F1E8 A Tattered, Plainly Drawn Treasure Map
[16:33:20.846]   [container] 0x4004F1EB Pouch
[16:33:20.846]   [item]      0x4004F1EC Robe (hue 0x08FD "Animals #0")
[16:33:20.900] [CONTAINER] +1 0x1F03 (0x4004F1EC)
[16:33:20.846] [CMD-END] container 0x4004F3E7 ok
"""

# Made-up items and rules, so the ordering tests do not move when the real data does.
ITEMS = {
    "Gold": {"graphics": ["0x0EED"], "pay": 1, "weight": 1 / 150},
    "Ruby": {"graphics": ["0x0F13"], "pay": 37, "weight": 0.1},
    "Gizmo": {"pay": 100, "weight": 1.0},
    "Brick": {"pay": 5, "weight": 10.0},
    "Pebble": {"pay": 2, "weight": 0.1},
    "Pricey": {"charge": 40, "weight": 1.0},
    "Anvil": {"weight": 20.0},
    "Bauble": {"weight": 0.5},
    "Longsword": {"pay": 27, "weight": 7.0, "family": "BaseWeapon"},
}
RULES = {"rules": [{"why": "gold", "types": ["Gold"], "names": ["^gold coins?$"]},
                   {"why": "gems", "graphics": ["0x0F13"]},
                   {"why": "magic", "props": ["^damage increase\\b"]}]}


def listing(*rows):
    return "\n".join(["[CONTAINER] 0x40000001 A Corpse x56:"] +
                     [f"  [item]      0x{0x40000100 + i:08X} {row}" for i, row in enumerate(rows)])


def source(text):
    with tempfile.NamedTemporaryFile("w", suffix=".cs", delete=False) as f:
        f.write(text)
    try:
        return itemvalues.Source(f.name)
    finally:
        os.remove(f.name)


class ItemValues(unittest.TestCase):
    def test_evaluates_era_and_whole_number_arithmetic(self):
        self.assertAlmostEqual(itemvalues.evaluate("Core.ML ? 0.02 / 3 : 0.02"), 0.02 / 3)
        self.assertEqual(itemvalues.evaluate("Core.SA ? 1.0 : 3.0"), 3.0)
        self.assertEqual(itemvalues.evaluate("Core.Expansion >= Expansion.AOS"), True)
        self.assertEqual(itemvalues.evaluate("12 + i / 8 * 10", {"i": 9}), 22)
        self.assertEqual(itemvalues.evaluate("(i / 8 + 2) * 2", {"i": 63}), 18)
        self.assertEqual(itemvalues.evaluate("0x1F2D"), 0x1F2D)
        self.assertEqual(itemvalues.evaluate("1.5f"), 1.5)
        self.assertIsNone(itemvalues.evaluate("Utility.Random(5)"))
        self.assertIsNone(itemvalues.era("BaseHouse.NewVendorSystem"))

    def test_prunes_only_the_branches_our_era_never_takes(self):
        code = ("if (Core.AOS) { A(); } if (!Core.AOS) { B(); } if (Core.SA) { C(); } else { D(); } "
                "if (Guild.NewGuildSystem) { E(); } else { F(); }")
        kept = itemvalues.prune(code)
        self.assertEqual(len(kept), len(code))
        for call in ("A()", "D()", "E()", "F()"):
            self.assertIn(call, kept)
        for call in ("B()", "C()"):
            self.assertNotIn(call, kept)

    def test_reads_item_classes(self):
        src = source(GEMS)
        read = {c["name"]: itemvalues.read_class(src, c) for c in src.classes}
        self.assertEqual(read["StarSapphire"]["graphics"], [0xF21, 0xF22])
        self.assertEqual(read["StarSapphire"]["weightExpr"], "0.1")
        self.assertEqual(read["BaseCoin"]["nameDecl"], "a contract of employment")
        self.assertEqual(read["BaseCoin"]["label"], 1041243)
        self.assertEqual(read["Doubloon"]["graphics"], [0xEED])  # the hue after the itemID is not a graphic
        self.assertEqual(read["Doubloon"]["base"], "BaseCoin")
        self.assertEqual(read["Trinket"]["graphics"], [0x1F14, 0x1F15])
        self.assertEqual(read["Trinket"]["nameDecl"], "a shiny trinket")
        self.assertNotIn("weightExpr", read["Trinket"])  # the nested class's weight is its own
        classes = {k: v for k, v in read.items()}
        classes["Item"] = {"type": "Item", "base": None, "graphics": []}
        self.assertEqual(itemvalues.inherited("Doubloon", classes, "weightExpr"), "Core.ML ? 0.02 / 3 : 0.02")
        self.assertEqual(itemvalues.family("Doubloon", classes), "BaseCoin")
        self.assertIsNone(itemvalues.family("StarSapphire", classes))

    def test_reads_vendor_lists_for_our_era(self):
        src = source(SHOP)
        scrolls = [f"S{i}Scroll" for i in range(64)]
        got = itemvalues.vendor_lists([src], {"RegularScrollTypes": scrolls})
        self.assertIn(("SBGems", "StarSapphire", "charge", 125, 0xF21), got)
        self.assertNotIn(("SBGems", "StarSapphire", "charge", 99, 0xF21), got)  # only before Age of Shadows
        self.assertIn(("SBGems", "Trinket", "charge", 1252, 0x14F0), got)
        self.assertIn(("SBGems", "Pitcher", "charge", 11, 0x1F95), got)
        self.assertFalse([g for g in got if g[1] == "Horse"])  # creatures are not items
        self.assertIn(("SBGems", "StarSapphire", "pay", 62, None), got)
        self.assertIn(("SBGems", "Trinket", "pay", 600, None), got)
        self.assertFalse([g for g in got if g[1] == "Trinket" and g[3] in (900, 5000)])
        bought = {g[1]: g[3] for g in got if g[2] == "charge" and g[1].endswith("Scroll")}
        self.assertEqual(len(bought), 16)  # two circles
        self.assertEqual((bought["S0Scroll"], bought["S15Scroll"]), (12, 22))
        sold = {g[1]: g[3] for g in got if g[2] == "pay" and g[1].endswith("Scroll")}
        self.assertEqual((len(sold), sold["S0Scroll"], sold["S63Scroll"]), (64, 4, 18))

    def test_data_file_has_values_and_graphics(self):
        items = loot.load(loot.ITEMS)
        self.assertEqual(items["Gold"]["pay"], 1)
        self.assertAlmostEqual(items["Gold"]["weight"], 1 / 150, places=5)
        self.assertEqual((items["StarSapphire"]["pay"], items["StarSapphire"]["charge"]), (62, 125))
        self.assertEqual(items["StarSapphire"]["graphics"][0], "0x0F21")
        self.assertEqual(items["Katana"]["family"], "BaseWeapon")
        self.assertEqual(items["ParalyzeScroll"]["family"], "SpellScroll")
        self.assertGreater(sum(1 for e in items.values() if "pay" in e), 300)


class Loot(unittest.TestCase):
    def test_parses_the_container_listing(self):
        got = loot.parse(LISTING)
        self.assertEqual(len(got), 9)
        gold, robe = got[0], got[-1]
        self.assertEqual((gold["serial"], gold["name"], gold["amount"]), ("0x4004F1E2", "31 Gold Coin", 31))
        self.assertEqual((robe["name"], robe["hue"], robe["graphic"]), ("Robe", 0x08FD, 0x1F03))
        self.assertTrue(got[7]["container"])
        self.assertEqual(loot.parse(LISTING.replace("[16:33:20.846] ", "")), got)
        empty = "[CONTAINER] 0x4004DCCA A Timber Wolf Corpse x225:\n  (empty, or not opened yet - try 'use <serial>')"
        self.assertEqual(loot.parse(empty), [])
        self.assertTrue(loot.unopened(empty))
        self.assertEqual(loot.status_weight("Gold:    1000   Weight: 60/345"), (60, 345))

    def test_knows_items_by_the_names_the_client_shows(self):
        for name, expected in [("31 Gold Coin", "Gold"), ("Spiders' Silk", "SpidersSilk"),
                               ("Blood Moss", "Bloodmoss"), ("Leather Tunic", "LeatherChest"),
                               ("Leather Leggings", "LeatherLegs"), ("Clean Bandage", "Bandage"),
                               ("Paralyze", "ParalyzeScroll"), ("3 Greater Heal Potion", "GreaterHealPotion"),
                               ("Tear Kite Shield", "WoodenKiteShield"), ("Platemail Gorget", "PlateGorget"),
                               ("Ornament of the Magician", "OrnamentOfTheMagician")]:
            self.assertEqual(loot.identify(name)[0], expected, name)
        self.assertEqual(loot.identify("A Tattered, Plainly Drawn Treasure Map"), ("TreasureMap", "guess"))
        self.assertEqual(loot.identify("Strange Doohickey"), (None, None))
        self.assertEqual(loot.identify("Strange Doohickey", graphic_id=0x0F21), ("StarSapphire", "graphic"))

    def test_valuables_first_then_gold_per_stone(self):
        text = listing("Brick", "Gizmo", "Pebble x10", "250 Gold Coin x250", "Ruby", "Pricey")
        got = loot.plan(text, 0, 400, ITEMS, RULES)
        self.assertEqual([loot.parse(text)[int(s, 16) - 0x40000100]["name"] for s, _, _ in got],
                         ["250 Gold Coin", "Ruby", "Gizmo", "Pebble", "Pricey", "Brick"])
        self.assertTrue(got[0][2].startswith("valuable, gold"))
        self.assertIn("half what a vendor charges", got[4][2])

    def test_stops_at_the_weight_limit_and_takes_part_of_a_stack(self):
        text = listing("1000 Gold Coin x1000", "Gizmo", "Pebble x30")
        got = loot.plan(text, 340, 345, ITEMS, RULES)
        self.assertEqual(got, [("0x40000100", 750, "valuable, gold; 750 of 1000 fit")])  # 5 of its 7 stones
        self.assertEqual(loot.plan(text, 345, 345, ITEMS, RULES), [])
        text = listing("300 Gold Coin x300", "Gizmo", "Pebble x30")
        got = loot.plan(text, 341, 345, ITEMS, RULES)  # 4 stones: the gold 2, the gizmo 1, a stone of pebbles
        self.assertEqual([(s, n) for s, n, _ in got], [("0x40000100", 300), ("0x40000101", 1), ("0x40000102", 10)])
        self.assertIn("10 of 30 fit", got[2][2])

    def test_unknown_items_go_last_and_only_when_light(self):
        text = listing("Anvil", "Strange Doohickey", "5 Mystery Shard x5", "Bauble", "Gizmo")
        got = loot.plan(text, 0, 400, ITEMS, RULES)
        names = [loot.parse(text)[int(s, 16) - 0x40000100]["name"] for s, _, _ in got]
        self.assertEqual(names, ["Gizmo", "Bauble", "Strange Doohickey"])  # lightest unknown first
        self.assertIn("weight unknown", got[-1][2])

    def test_containers_are_listed_not_taken(self):
        text = listing("Gizmo") + "\n  [container] 0x40000200 Pouch"
        ranked = loot.rank(text, ITEMS, RULES)
        self.assertEqual(ranked[-1]["tier"], 3)
        self.assertEqual([s for s, _, _ in loot.plan(text, 0, 400, ITEMS, RULES)], ["0x40000100"])

    def test_tooltips_give_weight_and_magic(self):
        text = listing("Longsword", "Brick")
        tips = {"0x40000100": "Weight: 8 Stones\nDamage Increase 25%\nDurability 40 / 40"}
        ranked = loot.rank(text, ITEMS, RULES, tooltips=tips)
        self.assertEqual((ranked[0]["tier"], ranked[0]["piece"]), (0, 8.0))
        self.assertTrue(ranked[0]["why"].startswith("valuable, magic"))
        plain = loot.rank(text, ITEMS, RULES, tooltips={"0x40000100": ["Weight: 7 Stones", "Durability 40 / 40"]})
        self.assertEqual(plain[0]["tier"], 1)

    def test_min_gold_per_stone_leaves_cheap_heavy_things(self):
        text = listing("Brick", "Gizmo")
        self.assertEqual([s for s, _, _ in loot.plan(text, 0, 400, ITEMS, RULES, min_per_stone=1)], ["0x40000101"])

    def test_a_real_looking_corpse(self):
        got = loot.plan(LISTING, 60, 345)
        self.assertEqual([s for s, _, _ in got[:4]], ["0x4004F1E2", "0x4004F1E4", "0x4004F1E8", "0x4004F1E5"])
        self.assertEqual(got[0][1], 31)
        self.assertNotIn("0x4004F1EB", [s for s, _, _ in got])  # the pouch: list it and loot what is inside
        self.assertEqual([s for s, _, _ in got[4:6]], ["0x4004F1E6", "0x4004F1E7"])  # 30 then 26 gold a stone
        # 3 stones: the gold, the gems and the map a stone each; the scroll and the rest wait
        self.assertEqual([s for s, _, _ in loot.plan(LISTING, 342, 345)], ["0x4004F1E2", "0x4004F1E4", "0x4004F1E8"])


if __name__ == "__main__":
    unittest.main()
