"""Tests for lab/skillplan.py: plans, caps and the locks they lead to. No game: python3 -m unittest discover -s lab"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import skillplan  # noqa: E402

NAVREY = ["[SKILL] Anatomy            50.3 (base  50.3) up", "[SKILL] Focus               3.2 (base   3.2) up",
          "[SKILL] Hiding              0.1 (base   0.1) dn",
          "[SKILL] Swordsmanship     100.0 (base 100.0) up", "[CMD-END] skills ok"]


class Plans(unittest.TestCase):
    def test_the_novices_plan_fits_our_shard(self):
        plan = skillplan.plan_of("warrior-novice")
        self.assertIn("Swordsmanship", plan["skills"])  # named as the client shows them
        self.assertEqual(skillplan.check(plan, skillplan.load(skillplan.SHARDS)["laya"]), [])

    def test_a_plan_over_the_caps_is_reported(self):
        plan = {"skills": {f"S{i}": 100 for i in range(8)}, "stats": {"str": 125, "dex": 125, "int": 25}}
        problems = skillplan.check(plan, {"skillsCap": 700, "skillCap": 100, "statCap": 225})
        self.assertEqual(len(problems), 2)

    def test_locks_follow_the_plan(self):
        plan = {"skills": {"Anatomy": 100, "Swordsmanship": 100}, "stats": {"str": 100, "dex": 100, "int": 25}}
        now = skillplan.parse_skills(NAVREY)
        self.assertEqual(now["Focus"], (3.2, 3.2, "up"))
        wanted = skillplan.skill_locks(plan, now)
        self.assertEqual(wanted, {"Anatomy": "up", "Focus": "down", "Hiding": "down", "Swordsmanship": "locked"})
        self.assertEqual(now["Hiding"][2], "down")  # Navrey prints a skill going down as "dn"
        self.assertEqual(skillplan.stat_locks(plan, {"str": 70, "dex": 100, "int": 30}), {"str": "up", "dex": "locked", "int": "down"})
        cmds = skillplan.commands(now, wanted, {"str": "Up", "dex": "Up", "int": "Up"}, {"str": "up", "dex": "locked", "int": "down"})
        self.assertEqual(cmds, ["skilllock Focus down", "skilllock Swordsmanship locked", "statlock dex locked", "statlock int down"])

    def test_every_skill_when_the_zeros_are_unknown(self):
        plan = {"skills": {"Swordsmanship": 100}, "stats": {}}
        wanted = skillplan.skill_locks(plan, {}, every=True)
        self.assertEqual(len(wanted), 58)
        self.assertEqual((wanted["Swordsmanship"], wanted["Hiding"]), ("up", "down"))


if __name__ == "__main__":
    unittest.main()
