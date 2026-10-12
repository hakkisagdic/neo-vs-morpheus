# uo-bench/1 leaderboard

Score: share of points (win 1, draw 1/2) against the track's opponent; 95% interval from a bootstrap over runs; settled when within ±3 points.

## ml/duel-archer

Archer against the scripted archer at matched speed, on five arenas, from both seats.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-duel-v8r-s2 archer | 49.5 | 39.9–59.5 | 100 (10) | 0 | no |
| 2 | random archer | 44.2 | 40.8–47.6 | 800 (80) | 0 | no |
| 3 | neo-skill-v1 archer | 37.8 | 32.5–43.6 | 360 (36) | 3 | no |
| 4 | neo-duel-v8s4 archer | 22.4 | 17.9–26.8 | 580 (58) | 16 | no |
| 5 | laya-base archer | 5.1 | 3.3–7.6 | 450 (45) | 14 | yes |

## ml/duel-dexer

Dexer (sword and shield) against the scripted dexer at matched speed, on five arenas, from both seats.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-duel-v8r-s2 dexer | 60.0 | 36.4–81.8 | 110 (11) | 1 | no |
| 2 | random dexer | 45.9 | 40.6–50.9 | 790 (79) | 0 | no |
| 3 | neo-duel-v8s4 dexer | 45.1 | 35.4–55.1 | 590 (59) | 18 | no |
| 4 | neo-skill-v1 dexer | 39.1 | 30.9–47.6 | 400 (40) | 0 | no |
| 5 | laya-base dexer | 0.2 | 0.0–1.2 | 450 (45) | 17 | yes |

## ml/duel-mage

Mage against the scripted mage at matched speed (it reacts in 40 ms), on five arenas, from both seats.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1 mage | 65.9 | 58.8–72.6 | 340 (34) | 5 | no |
| 2 | neo-duel-v8r-s2 mage | 64.0 | 47.0–79.0 | 100 (10) | 2 | no |
| 3 | neo-duel-v8s4 mage | 63.7 | 56.6–70.8 | 380 (38) | 1 | no |
| 4 | laya-base mage | 24.5 | 19.1–30.2 | 440 (44) | 16 | no |
| 5 | random mage | 14.8 | 12.3–17.7 | 790 (79) | 4 | yes |

## ml/equal-archer

Archer against the scripted archer, both deciding at one pace: every move acts 4 s after the state it answers, so that models of very different speeds (Jev's 3 s, Laya's 40 ms) are compared on judgement alone. Retired on 7 October 2026: the models were not told the pace, and at 4 s a move a different game wins (big spells over quick ones); ml/paced-* replaces it.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-duel-v8r-s2@4000 archer | 50.0 | 38.6–61.4 | 70 (7) | 0 | no |
| 2 | typesafe/jev-1.13-20260917@4000 archer | 40.0 | 25.0–60.0 | 40 (4) | 0 | no |
| 3 | neo-duel-v8s4@4000 archer | 34.0 | 29.3–39.3 | 400 (40) | 0 | no |
| 4 | random@4000 archer | 30.1 | 27.0–33.4 | 790 (79) | 0 | no |
| 5 | laya-base@4000 archer | 20.8 | 17.5–24.5 | 540 (54) | 0 | no |

## ml/equal-dexer

Dexer against the scripted dexer, both deciding at one pace: every move acts 4 s after the state it answers, so that models of very different speeds (Jev's 3 s, Laya's 40 ms) are compared on judgement alone. Retired on 7 October 2026: the models were not told the pace, and at 4 s a move a different game wins (big spells over quick ones); ml/paced-* replaces it.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-duel-v8r-s2@4000 dexer | 50.7 | 33.6–67.9 | 140 (14) | 0 | no |
| 2 | neo-duel-v8s4@4000 dexer | 45.5 | 34.5–56.3 | 400 (40) | 0 | no |
| 3 | random@4000 dexer | 35.4 | 30.9–39.9 | 800 (80) | 0 | no |
| 4 | typesafe/jev-1.13-20260917@4000 dexer | 35.0 | 6.7–66.7 | 60 (6) | 0 | no |
| 5 | laya-base@4000 dexer | 20.3 | 16.9–23.9 | 590 (59) | 0 | no |

## ml/equal-mage

Mage against the scripted mage, both deciding at one pace: every move acts 4 s after the state it answers, so that models of very different speeds (Jev's 3 s, Laya's 40 ms) are compared on judgement alone. Retired on 7 October 2026: the models were not told the pace, and at 4 s a move a different game wins (big spells over quick ones); ml/paced-* replaces it.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | laya-base@4000 mage | 46.9 | 40.0–54.0 | 566 (57) | 1 | no |
| 2 | neo-duel-v8r-s2@4000 mage | 46.0 | 36.0–57.0 | 100 (10) | 1 | no |
| 3 | neo-duel-v8s4@4000 mage | 34.5 | 27.8–41.0 | 400 (40) | 0 | no |
| 4 | random@4000 mage | 22.6 | 19.5–25.8 | 800 (80) | 0 | no |
| 5 | typesafe/jev-1.13-20260917@4000 mage | 15.1 | 11.4–19.0 | 400 (40) | 0 | no |

## ml/paced-archer

Archer against the scripted archer, both deciding at one pace: every move acts 4 s after the state it answers, and a model reads its pace in the state, so that models of very different speeds (Jev's 3 s, Laya's 40 ms) are compared on judgement, knowing the game they play.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1@4000 archer | 44.0 | 41.5–46.5 | 1560 (156) | 0 | yes |
| 2 | typesafe/jev-1.13-20260917@4000 archer | 40.1 | 33.9–46.6 | 227 (23) | 0 | no |
| 3 | neo-duel-v8s4@4000 archer | 36.0 | 33.5–38.5 | 1740 (174) | 0 | yes |
| 4 | random@4000 archer | 30.9 | 29.3–32.6 | 3103 (311) | 0 | yes |
| 5 | clef@4000 archer | 22.8 | 21.0–24.6 | 2280 (228) | 0 | yes |
| 6 | laya-base@4000 archer | 19.2 | 17.4–21.2 | 2250 (225) | 0 | yes |
| 7 | jev (model not recorded)@4000 archer | — | —–— | 0 (0) | 1 | no |

## ml/paced-dexer

Dexer against the scripted dexer, both deciding at one pace: every move acts 4 s after the state it answers, and a model reads its pace in the state, so that models of very different speeds (Jev's 3 s, Laya's 40 ms) are compared on judgement, knowing the game they play.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1@4000 dexer | 46.7 | 41.1–51.8 | 1560 (156) | 0 | no |
| 2 | neo-duel-v8s4@4000 dexer | 37.5 | 32.5–42.9 | 1770 (177) | 0 | no |
| 3 | random@4000 dexer | 32.6 | 30.5–35.0 | 3067 (309) | 0 | yes |
| 4 | typesafe/jev-1.13-20260917@4000 dexer | 28.5 | 18.0–39.0 | 300 (30) | 2 | no |
| 5 | clef@4000 dexer | 25.4 | 22.6–28.3 | 2340 (234) | 0 | yes |
| 6 | laya-base@4000 dexer | 22.2 | 20.1–24.2 | 2480 (248) | 0 | yes |
| 7 | jev (model not recorded)@4000 dexer | — | —–— | 0 (0) | 1 | no |

## ml/paced-mage

Mage against the scripted mage, both deciding at one pace: every move acts 4 s after the state it answers, and a model reads its pace in the state, so that models of very different speeds (Jev's 3 s, Laya's 40 ms) are compared on judgement, knowing the game they play.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | laya-base@4000 mage | 50.1 | 46.7–53.7 | 2380 (238) | 0 | no |
| 2 | clef@4000 mage | 46.4 | 43.4–49.3 | 2330 (233) | 0 | yes |
| 3 | neo-skill-v1@4000 mage | 45.7 | 42.4–49.0 | 1660 (166) | 0 | no |
| 4 | neo-duel-v8s4@4000 mage | 44.5 | 40.9–48.4 | 1830 (183) | 0 | no |
| 5 | random@4000 mage | 23.7 | 21.4–25.8 | 2481 (249) | 77 | yes |
| 6 | typesafe/jev-1.13-20260917@4000 mage | 23.0 | 16.1–30.0 | 220 (22) | 3 | no |
| 7 | jev (model not recorded)@4000 mage | — | —–— | 0 (0) | 1 | no |

## ml/spar-archer

Archer against a frozen model, neo-duel-v8r-s2 (the champion of 6 October), both at their own speed, on five arenas, from both seats: a stronger opponent than the scripted bot, and a fixed one, so that scores stay comparable.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1 archer | 40.5 | 37.9–42.9 | 1670 (167) | 0 | yes |
| 2 | neo-duel-v8s4 archer | 28.1 | 25.5–30.7 | 1640 (164) | 2 | yes |

## ml/spar-dexer

Dexer against a frozen model, neo-duel-v8r-s2 (the champion of 6 October), both at their own speed, on five arenas, from both seats: a stronger opponent than the scripted bot, and a fixed one, so that scores stay comparable.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1 dexer | 53.0 | 47.1–58.9 | 1760 (176) | 0 | no |
| 2 | neo-duel-v8s4 dexer | 38.8 | 32.6–45.1 | 1700 (170) | 6 | no |

## ml/spar-mage

Mage against a frozen model, neo-duel-v8r-s2 (the champion of 6 October), both at their own speed, on five arenas, from both seats: a stronger opponent than the scripted bot, and a fixed one, so that scores stay comparable.

| # | player | score | 95% interval | rounds (runs) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1 mage | 39.8 | 36.4–43.3 | 1740 (174) | 0 | no |
| 2 | neo-duel-v8s4 mage | 38.1 | 35.3–40.8 | 1760 (176) | 5 | yes |

## ml/skill-magery: Magery gained in 20 min

Magery points gained in the first 20 minutes, the mean over sessions; settled within ±0.5 points over at least 20 sessions.

| # | player | Magery gained | 95% interval | sessions | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1 mage-trainee | 10.3 | 10.2–10.5 | 108 | 1 | yes |
| 2 | neo-skill-v2 mage-trainee | 10.2 | 10.0–10.3 | 120 | 0 | yes |
| 3 | oracle mage-trainee | 10.0 | 9.9–10.1 | 344 | 14 | yes |
| 4 | rules mage-trainee | 8.6 | 8.5–8.7 | 281 | 20 | yes |
| 5 | random mage-trainee | 2.7 | 2.4–3.1 | 18 | 18 | no |
| 6 | clef mage-trainee | — | —–— | 0 | 116 | no |
| 7 | neo-duel-v8s4 mage-trainee | — | —–— | 0 | 8 | no |

## ml/skill-magery: minutes from 50 to 70

Minutes from Magery 50 to 70, counted as 90 when not reached by then (a restricted mean, so that a player that never gets there still counts); settled within ±3 minutes over at least 20 sessions.

| # | player | minutes | 95% interval | sessions (reached) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | neo-skill-v1 mage-trainee | 44.8 | 44.3–45.3 | 108 (108) | 1 | yes |
| 2 | oracle mage-trainee | 45.5 | 45.2–45.9 | 344 (344) | 14 | yes |
| 3 | neo-skill-v2 mage-trainee | 45.8 | 45.3–46.3 | 120 (120) | 0 | yes |
| 4 | rules mage-trainee | 50.7 | 50.4–51.1 | 281 (281) | 20 | yes |
| 5 | random mage-trainee | 90.0 | 90.0–90.0 | 18 (0) | 18 | no |
| 6 | clef mage-trainee | — | —–— | 0 (0) | 116 | no |
| 7 | neo-duel-v8s4 mage-trainee | — | —–— | 0 (0) | 8 | no |

## ml/skill-necromancy: Necromancy gained in 20 min

Necromancy points gained in the first 20 minutes, the mean over sessions; settled within ±0.5 points over at least 20 sessions.

| # | player | Necromancy gained | 95% interval | sessions | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | oracle necro-trainee | 10.7 | 10.6–10.8 | 122 | 0 | yes |
| 2 | rules necro-trainee | 10.5 | 10.3–10.6 | 112 | 0 | yes |
| 3 | random necro-trainee | 5.9 | 5.7–6.0 | 56 | 0 | yes |
| 4 | neo-v10s1 necro-trainee | — | —–— | 0 | 8 | no |
| 5 | neo-v10s2 necro-trainee | — | —–— | 0 | 8 | no |

## ml/skill-necromancy: minutes from 50 to 70

Minutes from Necromancy 50 to 70, counted as 90 when not reached by then (a restricted mean, so that a player that never gets there still counts); settled within ±3 minutes over at least 20 sessions.

| # | player | minutes | 95% interval | sessions (reached) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | oracle necro-trainee | 38.9 | 38.5–39.4 | 122 (122) | 0 | yes |
| 2 | rules necro-trainee | 43.3 | 42.8–43.8 | 112 (112) | 0 | yes |
| 3 | random necro-trainee | 83.5 | 82.3–84.8 | 56 (50) | 0 | yes |
| 4 | neo-v10s1 necro-trainee | — | —–— | 0 (0) | 8 | no |
| 5 | neo-v10s2 necro-trainee | — | —–— | 0 (0) | 8 | no |

## ml/skill-chivalry: Chivalry gained in 20 min

Chivalry points gained in the first 20 minutes, the mean over sessions; settled within ±0.5 points over at least 20 sessions.

| # | player | Chivalry gained | 95% interval | sessions | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | oracle paladin-trainee | 16.6 | 16.4–16.8 | 207 | 0 | yes |
| 2 | random paladin-trainee | 9.2 | 9.0–9.4 | 98 | 0 | yes |
| 3 | rules paladin-trainee | 8.3 | 8.0–8.6 | 99 | 0 | yes |
| 4 | neo-v10s1 paladin-trainee | — | —–— | 0 | 8 | no |
| 5 | neo-v10s2 paladin-trainee | — | —–— | 0 | 8 | no |

## ml/skill-chivalry: minutes from 50 to 70

Minutes from Chivalry 50 to 70, counted as 90 when not reached by then (a restricted mean, so that a player that never gets there still counts); settled within ±3 minutes over at least 20 sessions.

| # | player | minutes | 95% interval | sessions (reached) | flagged | settled |
|---|---|---|---|---|---|---|
| 1 | oracle paladin-trainee | 24.1 | 23.9–24.3 | 207 (207) | 0 | yes |
| 2 | rules paladin-trainee | 46.9 | 46.3–47.5 | 99 (99) | 0 | yes |
| 3 | random paladin-trainee | 46.9 | 46.3–47.6 | 98 (98) | 0 | yes |
| 4 | neo-v10s1 paladin-trainee | — | —–— | 0 (0) | 8 | no |
| 5 | neo-v10s2 paladin-trainee | — | —–— | 0 (0) | 8 | no |

## Ratings: mage

Bradley-Terry over every mage duel at the players' own speed (duel, sparring and ladder tracks), Elo scale, the scripted bot at 1000; 95% interval from a bootstrap over runs.

| # | player | rating | 95% interval | rounds | opponents |
|---|---|---|---|---|---|
| 1 | neo-duel-v8r-s2 mage | 1172 | 1136–1213 | 3600 | 3 |
| 2 | neo-skill-v1 mage | 1102 | 1067–1143 | 2080 | 2 |
| 3 | neo-duel-v8s4 mage | 1089 | 1054–1133 | 2140 | 2 |
| 4 | rules@40 mage | 1000 | 1000–1000 | 2050 | 5 |
| 5 | laya-base mage | 806 | 752–848 | 440 | 1 |
| 6 | random mage | 697 | 657–730 | 790 | 1 |

## Ratings: dexer

Bradley-Terry over every dexer duel at the players' own speed (duel, sparring and ladder tracks), Elo scale, the scripted bot at 1000; 95% interval from a bootstrap over runs.

| # | player | rating | 95% interval | rounds | opponents |
|---|---|---|---|---|---|
| 1 | rules@40 dexer | 1000 | 1000–1000 | 2340 | 5 |
| 2 | neo-skill-v1 dexer | 998 | 947–1055 | 2160 | 2 |
| 3 | neo-duel-v8r-s2 dexer | 994 | 947–1045 | 3570 | 3 |
| 4 | random dexer | 971 | 934–1003 | 790 | 1 |
| 5 | neo-duel-v8s4 dexer | 928 | 876–981 | 2290 | 2 |
| 6 | laya-base dexer | 9 | -210–165 | 450 | 1 |

## Ratings: archer

Bradley-Terry over every archer duel at the players' own speed (duel, sparring and ladder tracks), Elo scale, the scripted bot at 1000; 95% interval from a bootstrap over runs.

| # | player | rating | 95% interval | rounds | opponents |
|---|---|---|---|---|---|
| 1 | rules@40 archer | 1000 | 1000–1000 | 2290 | 5 |
| 2 | neo-duel-v8r-s2 archer | 968 | 937–1000 | 3410 | 3 |
| 3 | random archer | 959 | 934–983 | 800 | 1 |
| 4 | neo-skill-v1 archer | 903 | 870–931 | 2030 | 2 |
| 5 | neo-duel-v8s4 archer | 800 | 766–826 | 2220 | 2 |
| 6 | laya-base archer | 496 | 398–556 | 450 | 1 |

