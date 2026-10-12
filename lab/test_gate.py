#!/usr/bin/env python3
"""The gate's one look (lab/trainer.py), checked on made-up runs:

    python3 -m unittest lab/test_gate.py

Its error rate is the reason it exists: with arenas that differ a lot and rounds that go together
inside a run, a candidate that is no better must pass about one time in twenty and not more.
"""
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import trainer  # noqa: E402

BUILDS = ["mage", "dexer", "archer"]


def play(rng, shift=0.0, passes=6, kappa=8.0):
    """A checkpoint's runs of a gate-like series: 3 builds x 10 strata, 10 rounds a run. A stratum's
    share is fixed (from 10% to 90%, the same for every checkpoint, plus `shift`); each run draws its
    own share around it (a beta with this concentration: the rounds of a run go together, a design
    effect of about 2, as the bench's runs show)."""
    runs = []
    for b, build in enumerate(BUILDS):
        for k in range(10):
            mu = 0.10 + 0.80 * ((7 * k + 3 * b) % 10) / 9 + shift
            for _ in range(passes):
                p = rng.betavariate(mu * kappa, (1 - mu) * kappa)
                wins = sum(rng.random() < p for _ in range(10))
                runs.append((build, f"arena {k}", wins, 10 - wins))
    return runs


class Gate(unittest.TestCase):
    def test_waits_for_rounds_and_for_runs_in_every_stratum(self):
        rng = random.Random(1)
        mine, best = play(rng, passes=6), play(rng, passes=6)
        self.assertEqual(trainer.gate_waits(mine, best, BUILDS, 600), "")
        self.assertEqual(trainer.gate_waits(mine, best, BUILDS, 601), "waiting for 601 decided rounds of mage each (600 and 600)")
        thin = [r for r in mine if not (r[0] == "dexer" and r[1] == "arena 4")] + [("dexer", "arena 4", 5, 5)] * 2
        self.assertIn("3 runs each of dexer at arena 4", trainer.gate_waits(thin, best, BUILDS, 500))
        self.assertIn("decided rounds of mage each (0 and", trainer.gate_waits([], best, BUILDS, 600))

    def test_difference_is_taken_within_strata(self):
        # The candidate wins everything in the stratum it played more often: pooled, it looks ahead.
        mine = [("mage", "easy", 9, 1)] * 6 + [("mage", "hard", 1, 9)] * 3
        best = [("mage", "easy", 9, 1)] * 3 + [("mage", "hard", 1, 9)] * 6
        diff, se = trainer.gate_difference(mine, best, ["mage"])
        self.assertAlmostEqual(diff, 0.0)
        self.assertGreater(se, 0.0)

    def test_runs_that_all_end_the_same_still_have_an_error(self):
        p, variance = trainer.stratum_share([(10, 0)] * 6)
        self.assertEqual(p, 1.0)
        self.assertGreater(variance, 0.0)
        self.assertLess(math.sqrt(variance), 0.03)

    def test_error_rate_and_power(self):
        rng = random.Random(20261012)

        def passed(shift, margin, n=400):
            count = 0
            for _ in range(n):
                diff, se = trainer.gate_difference(play(rng, shift), play(rng), BUILDS)
                count += (diff + margin) / se > trainer.GATE_Z
            return count / n

        # No better: about 5% pass, and no more (400 tries: 5% has a standard error of 1.1 points).
        self.assertLessEqual(passed(0.0, 0.0), 0.08)
        # Worse by exactly the margin: the same.
        self.assertLessEqual(passed(-0.05, 0.05), 0.08)
        # As good, with the 5-point margin: mostly in (~80%); 4 points better: promoted more often than not (~60%).
        self.assertGreaterEqual(passed(0.0, 0.05), 0.7)
        self.assertGreaterEqual(passed(0.04, 0.0), 0.5)


if __name__ == "__main__":
    unittest.main()
