"""Tests for the scripts around the agent sessions: the bestiary, the places, the harness's helpers, the
training grounds, the terrain, the session report and the tidy rules. No game, no network:
python3 -m unittest discover -s lab"""
import glob
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bestiary  # noqa: E402
import poi  # noqa: E402
import session_report  # noqa: E402
import terrain  # noqa: E402
import tidy  # noqa: E402
import uo_agent  # noqa: E402

WOLF = """
namespace Server.Mobiles
{
    public partial class TimberWolf : BaseCreature
    {
        [Constructible]
        public TimberWolf() : base(AIType.AI_Animal, FightMode.Aggressor)
        {
            Body = 225;
            SetStr(56, 80);
            SetHits(34, 48);
            SetDamage(5, 9);
            SetDamageType(ResistanceType.Physical, 100);
            SetResistance(ResistanceType.Physical, 15, 20);
            SetSkill(SkillName.Tactics, 30.1, 50.0);
            SetSkill(SkillName.Wrestling, 40.1, 60.0);
            Fame = 450;
        }

        public override string DefaultName => "a timber wolf";
    }
}
"""
ME = dict(uo_agent.FIGHTER, hits=85)


def put(path, text):
    with open(path, "w") as f:
        f.write(text)


class Bestiary(unittest.TestCase):
    def test_reads_a_creature_class(self):
        with tempfile.NamedTemporaryFile("w", suffix=".cs", delete=False) as f:
            f.write(WOLF)
        try:
            (c,) = bestiary.read(f.name)
        finally:
            os.remove(f.name)
        self.assertEqual((c["type"], c["name"], c["ai"], c["fightMode"], c["body"]), ("TimberWolf", "a timber wolf", "animal", "Aggressor", 225))
        self.assertEqual((c["hits"], c["damage"], c["skills"]["Wrestling"]), ([34, 48], [5, 9], [40.1, 60.0]))
        self.assertEqual(c["resist"]["physical"], [15, 20])

    def test_danger_runs_from_rat_to_lich(self):
        with open(os.path.join(tidy.ROOT, "data", "bestiary.json")) as f:
            beasts = {c["type"]: c for c in json.load(f).values()}
        losses = [bestiary.danger(beasts[t], ME)["loss"] for t in ("Rat", "TimberWolf", "Harpy", "Lich")]
        self.assertEqual(losses, sorted(losses))
        self.assertEqual([bestiary.level(x) for x in (0.1, 0.5, 1.0, 2.0)], ["low", "medium", "high", "deadly"])


class Places(unittest.TestCase):
    TOWNS = [{"Map": "Trammel", "Name": "New Haven", "Area": [{"x1": 3416, "y1": 2480, "x2": 3545, "y2": 2648}],
              "GoLocation": {"x": 3503, "y": 2574, "z": 14}}]

    def test_regions_of_another_expansion_are_left_out(self):
        self.assertFalse(poi.active({"MaxExpansion": "SE"}, "ML"))
        self.assertTrue(poi.active({"MinExpansion": "ML"}, "ML"))
        self.assertTrue(poi.active({}, "ML"))

    def test_town_of_names_inside_near_and_nothing(self):
        self.assertEqual(poi.town_of(self.TOWNS, "Trammel", 3484, 2570), "New Haven")
        self.assertEqual(poi.town_of(self.TOWNS, "Trammel", 3620, 2617), "near New Haven")
        self.assertIsNone(poi.town_of(self.TOWNS, "Trammel", 1000, 1000))

    def test_index_puts_points_in_grid_cells(self):
        idx = poi.index([{"x": 150, "y": 250, "name": "a"}, {"x": 160, "y": 210, "name": "b"}, {"x": 900, "y": 10, "name": "c"}])
        self.assertEqual(sorted(idx["cells"]), ["1,2", "9,0"])
        self.assertEqual(idx["pointCount"], 3)


class Harness(unittest.TestCase):
    def test_direction(self):
        self.assertEqual([uo_agent.direction(*d) for d in ((0, 0), (-5, 0), (3, -3), (1, -5))], ["here", "W", "NE", "N"])

    def test_trimming_keeps_the_beginning_for_many_calls(self):
        system = {"role": "system", "content": "x"}
        turns = [[{"role": "user", "content": "y" * 1000}] for _ in range(200)]
        start, starts = 0, []
        for n in range(1, 201):
            _, start = uo_agent.trimmed(system, turns[:n], start)
            starts.append(start)
        self.assertLessEqual(sum(1 for a, b in zip(starts, starts[1:]) if a != b), 6)  # the prompt cache survives

    def test_the_model_cannot_use_client_side_commands(self):
        self.assertEqual(uo_agent.command("record /tmp/x.mp4"), "'record' is not available to you")
        self.assertEqual(uo_agent.command("hide"), "'hide' is not available to you")
        self.assertEqual(uo_agent.command("  "), "empty command")

    def test_threat_reads_the_bestiary(self):
        wolf = {"name": "a timber wolf", "graphic": 225, "isHuman": False}
        text = uo_agent.threat(wolf, {"hits": 85, "maxHits": 85})
        self.assertRegex(text, r"^, danger (low|medium): a fight would cost about \d+% of your health now, fights back only$")
        self.assertEqual(uo_agent.threat({"name": "Dunstan", "graphic": 400, "isHuman": True}, {"hits": 85, "maxHits": 85}), "")


class Grounds(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(tidy.ROOT, "data", "bestiary.json")) as f:
            self.beasts = {c["type"]: c for c in json.load(f).values()}

    def test_every_ground_fits_its_bounds_and_starts_out_of_reach(self):
        for path in glob.glob(os.path.join(uo_agent.GROUNDS, "*.json")):
            g = uo_agent.load_ground(os.path.basename(path)[:-5])
            x1, y1, x2, y2 = g["bounds"]
            types = [s["type"] for s in g["spawns"]]
            self.assertEqual(len(types), len(set(types)), "a type appears once: the census counts by type")
            for s in g["spawns"]:
                c = self.beasts[s["type"]]
                self.assertTrue(x1 <= s["at"][0] <= x2 and y1 <= s["at"][1] <= y2, s)
                if c["fightMode"] in ("Closest", "Evil"):
                    # Whatever attacks on sight must not see the start, where the character comes back.
                    far = max(abs(s["at"][0] - g["start"][0]), abs(s["at"][1] - g["start"][1])) - s["range"]
                    self.assertGreater(far, s.get("perception", 16), s["type"])
            text = uo_agent.SYSTEM.format(name="X", start=g["prompt"]["start"], goal=g["prompt"]["goal"].format(minutes=30),
                                          world=g["prompt"]["world"], death=g["prompt"]["death"])
            for part in ("start", "world"):
                self.assertNotIn(uo_agent.TOWN[part], text)
                self.assertIn(g["prompt"][part], text)

    def test_census_reads_the_gm_answers(self):
        g = {"center": [100, 100], "bounds": [-5, -5, 5, 5], "map": "Felucca",
             "spawns": [{"type": "Rat", "count": 3}, {"type": "Troll", "count": 1}, {"type": "Hind", "count": 2}]}
        answer = ("> [Global Count where Rat Map = Felucca X >= 95 X <= 105 Y >= 95 Y <= 105\n  There are 2 matching objects.\n"
                  "> [Global Count where Troll Map = Felucca X >= 95 X <= 105 Y >= 95 Y <= 105\n  No matching objects found.\n"
                  "> [Global Count where Hind Map = Felucca X >= 95 X <= 105 Y >= 95 Y <= 105\n  There is one matching object.\n")
        old = uo_agent.gm
        uo_agent.gm = lambda *commands, **_: (0, answer)
        try:
            self.assertEqual(uo_agent.census(g), {"Rat": 2, "Troll": 0, "Hind": 1})
            uo_agent.gm = lambda *commands, **_: (0, answer.split("> [Global Count where Hind")[0])
            self.assertIsNone(uo_agent.census(g))  # a type without an answer: no guess
        finally:
            uo_agent.gm = old


@unittest.skipUnless(os.path.exists(os.path.join(terrain.CLIENT, "map0LegacyMUL.uop")), "EA's client files")
class Terrain(unittest.TestCase):
    def test_reads_the_arena_yard_as_the_client_does(self):
        f = terrain.Facet("Felucca")
        self.assertEqual(f.land(1175, 3610), (0x0003, 0))  # the client's canwalk: land 0x0003 z=0
        self.assertEqual(f.statics(1176, 3600), [(0x05A4, 20)])  # a roof above the yard's north-west room
        self.assertEqual([f.kind(x, 3610) for x in (1166, 1167, 1180, 1199)], [".", "#", ".", "#"])  # the yard's walls


class Guard(unittest.TestCase):
    def test_attackers_are_the_fighting_creatures_in_reach_quickest_kill_first(self):
        mobiles = [{"name": "a skeleton", "graphic": 50, "distance": 1, "inWarMode": True, "hits": 100, "maxHits": 100},
                   {"name": "a rat", "graphic": 238, "distance": 1, "inWarMode": True, "hits": 100, "maxHits": 100},
                   {"name": "a hind", "graphic": 237, "distance": 1, "inWarMode": False},
                   {"name": "an evil mage", "graphic": 400, "distance": 6, "inWarMode": True}]
        d = tempfile.mkdtemp()
        old = uo_agent.WORLD
        try:
            uo_agent.WORLD = os.path.join(d, "world.json")
            put(uo_agent.WORLD, json.dumps({"mobiles": mobiles}))
            self.assertEqual([m["name"] for m in uo_agent.attackers({"hits": 85})], ["a rat", "a skeleton"])
            put(uo_agent.WORLD, json.dumps({"mobiles": mobiles[2:]}))
            self.assertEqual([m["name"] for m in uo_agent.attackers({"hits": 85})], ["an evil mage"])  # a caster hits from afar
        finally:
            uo_agent.WORLD = old
            shutil.rmtree(d)

    def test_an_action_chosen_before_a_reflex_fight_is_not_done(self):
        d = tempfile.mkdtemp()
        try:
            player = uo_agent.Player(d, "http://laya")
            player.note("a rat attacked you; Laya fought back, balanced: won")
            self.assertTrue(player.act(lambda: "done").startswith("Not done"))
            self.assertEqual(len(player.take_notes()), 1)
            self.assertEqual(player.act(lambda: "done"), "done")
            player.events.close()
            player.decisions.close()
        finally:
            shutil.rmtree(d)


class SessionReport(unittest.TestCase):
    def test_counts_fights_deaths_damage_and_gains(self):
        d = tempfile.mkdtemp()
        try:
            put(os.path.join(d, "run.json"), json.dumps({"model": "m", "system": "... Your character Gemma is a young swordsman"}))
            with open(os.path.join(d, "agent.jsonl"), "w") as f:
                f.write(json.dumps({"kind": "model", "ms": 1000}) + "\n")
                f.write(json.dumps({"kind": "tool", "name": "fight", "result": "won: a rat is dead after 2 s."}) + "\n")
                f.write(json.dumps({"kind": "tool", "name": "fight", "result": "died: you died fighting a harpy"}) + "\n")
            put(os.path.join(d, "decisions.jsonl"), json.dumps({"decision": "x"}) + "\n")
            with open(os.path.join(d, "state.jsonl"), "w") as f:
                for t, ghost in ((0, False), (60, True), (120, False)):
                    f.write(json.dumps({"t": t, "state": {"charGhost": ghost, "map": 1, "charPosX": 0, "charPosY": t, "gold": 1000}}) + "\n")
            put(os.path.join(d, "cuolog.txt"), 
                "[10:00:00.000] Damage: Gemma takes 7\n[10:00:01.000] Damage: a rat takes 12\n"
                "[10:00:02.000] [SYSTEM] Your skill in Tactics has increased by 0.1.  It is now 50.1.\n"
                "[10:00:03.000] *** You have died - you are a ghost ***\n")
            r = session_report.report(d)
        finally:
            shutil.rmtree(d)
        self.assertEqual((r["deaths"], r["resurrected"], r["damage dealt / taken"]), (1, 1, "12 / 7"))
        self.assertEqual((r["skill gains"], r["minutes"], r["fights (Laya)"]), ("Tactics +0.1", 2.0, "won 1, died 1"))


class Tidy(unittest.TestCase):
    def test_duplicates_counts_only_runs_already_imported(self):
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, "runs"))
            os.makedirs(os.path.join(root, ".fleet", "alastyr", "runs"))
            for name in ("a.json", "b.json"):
                put(os.path.join(root, ".fleet", "alastyr", "runs", name), "{}")
            put(os.path.join(root, "runs", "alastyr--a.json"), "{}")
            old, tidy.ROOT = tidy.ROOT, root
            try:
                self.assertIn("would remove 1 alastyr copies", tidy.rule_duplicates(apply=False))
            finally:
                tidy.ROOT = old
        finally:
            shutil.rmtree(root)

    @unittest.skipUnless(sys.platform == "darwin", "APFS compression")
    def test_compression_keeps_the_content(self):
        root = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(root, "runs"))
            path = os.path.join(root, "runs", "r.json")
            body = json.dumps({"records": [{"i": i, "text": "the same words again"} for i in range(20000)]})
            put(path, body)
            os.utime(path, (time.time() - 2 * 86400, time.time() - 2 * 86400))
            old, tidy.ROOT = tidy.ROOT, root
            try:
                tidy.rule_compress(apply=True)
            finally:
                tidy.ROOT = old
            with open(path) as f:
                self.assertEqual(f.read(), body)
            self.assertTrue(tidy.compressed(path))
        finally:
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
