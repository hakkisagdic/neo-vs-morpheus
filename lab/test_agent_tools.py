"""Tests for the scripts around the agent sessions: the bestiary, the places, the harness's helpers, the
session report and the tidy rules. No game, no network: python3 -m unittest discover -s lab"""
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
