#!/usr/bin/env python3
"""Points of interest for Navrey (`closest bank`, `findpoi`, `goto <name>`), made from the world
server's own data, so that they describe the shard the agents play on:

    python3 lab/poi.py                      # from the running laya-world container
    python3 lab/poi.py --data ~/UO/server-data --out ~/UO/poi

- towns and dungeon entrances from Data/regions.json (a town's "go location", a dungeon's entrance);
- shops from the spawners in Data/Spawns: the tile a banker or healer spawns on is inside the bank
  or the healer's, and walkable;
- moongates from the server's public moongate list;
- hunting grounds from the creature spawners: `closest hunt` (monsters), `closest animals`
  (wildlife), `findpoi skeleton`; named by what spawns there and the place.
Spawners count only from the sets the world was generated from (lab/world-spawns.json).

Navrey reads every *.json in the directory settings.json's "poi_directory" names, when it starts.
Standard library only.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import tempfile

MAPS = {"Felucca": 0, "Trammel": 1, "Ilshenar": 2, "Malas": 3, "Tokuno": 4, "TerMur": 5}
EXPANSIONS = ["None", "T2A", "UOR", "UOTD", "LBR", "AOS", "SE", "ML", "SA", "HS", "TOL", "EJ"]

# Spawned vendor -> category. The names the uo-* skills send to `closest` (bank, healer, stables)
# are kept as they are.
SHOPS = {
    "bank": ["Banker", "GypsyBanker", "Minter"],
    # Not the wandering healers: they roam far from their spawner, so a ghost sent there finds nobody.
    "healer": ["Healer", "HealerGuildmaster"],
    "provisioner": ["Provisioner"],
    "blacksmith": ["Blacksmith", "BlacksmithGuildmaster", "IronWorker"],
    "weaponsmith": ["Weaponsmith"],
    "armorer": ["Armorer"],
    "bowyer": ["Bowyer"],
    "mage": ["Mage", "MageGuildmaster", "HolyMage"],
    "alchemist": ["Alchemist"],
    "herbalist": ["Herbalist"],
    "tailor": ["Tailor", "TailorGuildmaster", "Weaver"],
    "inn": ["InnKeeper", "TavernKeeper", "Barkeeper"],
    "stables": ["AnimalTrainer", "GypsyAnimalTrainer"],
    "veterinarian": ["Veterinarian"],
    "butcher": ["Butcher"],
    "baker": ["Baker", "Cook"],
    "tinker": ["Tinker", "TinkerGuildmaster"],
    "carpenter": ["Carpenter"],
    "scribe": ["Scribe"],
    "jeweler": ["Jeweler"],
    "tanner": ["Tanner", "LeatherWorker"],
    "fisherman": ["Fisherman", "FisherGuildmaster"],
}
CATEGORY = {vendor: cat for cat, vendors in SHOPS.items() for vendor in vendors}
LABEL = {"bank": "Bank", "healer": "Healer", "inn": "Inn", "stables": "Stables"}
# Spawn files that hold no hunting: shops, townsfolk, fish, reagents and crops.
NOT_HUNTING = {"Vendors", "TownsLife", "TownsPeople", "Towns", "SeaLife", "Reagents", "FelCropsLS", "TramCropsLS"}

# PublicMoongate's lists (Mondain's Legacy): facet -> (name, x, y, z).
MOONGATES = {
    "Trammel": [("Moonglow", 4467, 1283, 5), ("Britain", 1336, 1997, 5), ("Jhelom", 1499, 3771, 5), ("Yew", 771, 752, 5),
                ("Minoc", 2701, 692, 5), ("Trinsic", 1828, 2948, -20), ("Skara Brae", 643, 2067, 5), ("Magincia", 3563, 2139, 34),
                ("New Haven", 3450, 2677, 25)],
    "Felucca": [("Moonglow", 4467, 1283, 5), ("Britain", 1336, 1997, 5), ("Jhelom", 1499, 3771, 5), ("Yew", 771, 752, 5),
                ("Minoc", 2701, 692, 5), ("Trinsic", 1828, 2948, -20), ("Skara Brae", 643, 2067, 5), ("Magincia", 3563, 2139, 34),
                ("Buccaneer's Den", 2711, 2234, 0)],
    "Ilshenar": [("Compassion", 1215, 467, -13), ("Honesty", 722, 1366, -60), ("Honor", 744, 724, -28), ("Humility", 281, 1016, 0),
                 ("Justice", 987, 1011, -32), ("Sacrifice", 1174, 1286, -30), ("Spirituality", 1532, 1340, -3), ("Valor", 528, 216, -45),
                 ("Chaos", 1721, 218, 96)],
    "Malas": [("Luna", 1015, 527, -65), ("Umbra", 1997, 1386, -85)],
    "Tokuno": [("Isamu-Jima", 1169, 998, 41), ("Makoto-Jima", 802, 1204, 25), ("Homare-Jima", 270, 628, 15)],
}


def server_data(container):
    """Copies regions.json and the spawners out of the running server."""
    folder = tempfile.mkdtemp(prefix="laya-poi-")
    for part in ("regions.json", "Spawns"):
        subprocess.run(["docker", "cp", f"{container}:/app/Data/{part}", folder], check=True, capture_output=True)
    return folder


def inside(area, x, y):
    return area["x1"] <= x <= area["x2"] and area["y1"] <= y <= area["y2"]


def town_of(towns, facet, x, y):
    """The smallest town region holding the tile, else the nearest town within 150 tiles."""
    holding = [(min((a["x2"] - a["x1"]) * (a["y2"] - a["y1"]) for a in t["Area"]), t["Name"])
               for t in towns if t["Map"] == facet and any(inside(a, x, y) for a in t["Area"])]
    if holding:
        return min(holding)[1]
    near = [(max(abs(t["GoLocation"]["x"] - x), abs(t["GoLocation"]["y"] - y)), t["Name"]) for t in towns if t["Map"] == facet]
    near = [n for n in near if n[0] <= 150]
    return f"near {min(near)[1]}" if near else None


def place_of(regions, towns, facet, x, y):
    """The smallest named region holding the tile (a dungeon, a town), else the nearest town."""
    holding = [(min((a["x2"] - a["x1"]) * (a["y2"] - a["y1"]) for a in r["Area"]), r["Name"])
               for r in regions if r["Map"] == facet and r.get("Name") and r.get("Area") and any(inside(a, x, y) for a in r["Area"])]
    return min(holding)[1] if holding else town_of(towns, facet, x, y) or "the wild"


def readable(type_name):
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", type_name)


def active(region, expansion):
    """Whether the region exists in the server's expansion (Haven's old town ends with SE)."""
    era = EXPANSIONS.index(expansion)
    low, high = region.get("MinExpansion", "None"), region.get("MaxExpansion", EXPANSIONS[-1])
    return EXPANSIONS.index(low) <= era <= EXPANSIONS.index(high)


def spawn_files(data, sets):
    """The spawn files of the sets the world was generated from ([GenerateSpawners Data/Spawns/<set>/...)."""
    return sorted(f for name in sets for f in glob.glob(os.path.join(data, "Spawns", name, "**", "*.json"), recursive=True))


def points(data, expansion, sets):
    regions = [r for r in json.load(open(os.path.join(data, "regions.json"))) if r.get("Map") in MAPS and active(r, expansion)]
    towns = [r for r in regions if r["$type"] == "TownRegion" and r.get("GoLocation")]
    out = []

    def add(facet, x, y, z, name, category, major=False):
        out.append({"x": x, "y": y, "z": z, "map": MAPS[facet], "name": name, "category": category, "major": major})

    for t in towns:
        g = t["GoLocation"]
        add(t["Map"], g["x"], g["y"], g.get("z", 0), t["Name"], "town", major=True)
    for d in regions:
        if d["$type"] == "DungeonRegion" and d.get("Entrance"):
            e = d["Entrance"]
            add(d["Map"], e["x"], e["y"], e.get("z", 0), f"{d['Name']} entrance", "dungeon")
    for facet, gates in MOONGATES.items():
        for name, x, y, z in gates:
            add(facet, x, y, z, f"{name} Moongate", "moongate", major=True)

    seen = []
    for path in spawn_files(data, sets):
        for s in json.load(open(path)):
            facet = s.get("map")
            if facet not in MAPS:
                continue
            x, y, z = s["location"]
            for e in s.get("entries", []):
                category = CATEGORY.get(e["name"])
                # One point per shop: spawners of the same kind within 12 tiles are one place.
                if not category or any(c == category and f == facet and max(abs(x - a), abs(y - b)) <= 12 for c, f, a, b in seen):
                    continue
                seen.append((category, facet, x, y))
                town = town_of(towns, facet, x, y)
                label = LABEL.get(category, category.capitalize())
                add(facet, x, y, z, f"{town} {label}" if town else label, category, major=category in ("bank", "healer"))

    # Hunting grounds: one point per creature mix and place, spawners within 40 tiles merged.
    hunts = []
    for path in spawn_files(data, sets):
        kind = os.path.splitext(os.path.basename(path))[0]
        if kind in NOT_HUNTING:
            continue
        for s in json.load(open(path)):
            facet = s.get("map")
            creatures = sorted({readable(e["name"]) for e in s.get("entries", []) if e["name"] not in CATEGORY
                                and not e["name"].startswith(("Treasure", "Hire", "Escort", "BaseEscort"))})
            if facet not in MAPS or not creatures:
                continue
            x, y, z = s["location"]
            if any(f == facet and c == creatures and max(abs(x - a), abs(y - b)) <= 40 for f, c, a, b in hunts):
                continue
            hunts.append((facet, creatures, x, y))
            mix = ", ".join(creatures[:5]) + (f" and {len(creatures) - 5} more" if len(creatures) > 5 else "")
            add(facet, x, y, z, f"{mix} - {place_of(regions, towns, facet, x, y)}", "animals" if kind == "WildLife" else "hunt")
    return out


def index(pts, grid=100):
    cells = {}
    for p in pts:
        cells.setdefault(f"{p['x'] // grid},{p['y'] // grid}", []).append(p)
    xs, ys = [p["x"] for p in pts], [p["y"] for p in pts]
    return {"gridSize": grid, "bounds": {"minX": min(xs), "maxX": max(xs), "minY": min(ys), "maxY": max(ys)},
            "pointCount": len(pts), "cellCount": len(cells), "cells": cells}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", help="a folder with regions.json and Spawns/ (default: copied from --container)")
    ap.add_argument("--container", default="laya-world")
    ap.add_argument("--out", default=os.path.expanduser("~/UO/poi"))
    ap.add_argument("--expansion", default="ML", choices=EXPANSIONS, help="the server's expansion (NEO_EXPANSION 7 is ML)")
    ap.add_argument("--spawns", help="the spawn sets the world was generated from (default: lab/world-spawns.json's)")
    args = ap.parse_args()
    pts = points(os.path.expanduser(args.data) if args.data else server_data(args.container), args.expansion,
                 args.spawns.split(",") if args.spawns else json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "world-spawns.json")))["sets"])
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "laya-world.json")
    with open(path, "w") as f:
        json.dump(index(pts), f, indent=1)
    counts = {}
    for p in pts:
        counts[p["category"]] = counts.get(p["category"], 0) + 1
    print(f"{len(pts)} points in {path}: " + ", ".join(f"{c} {n}" for c, n in sorted(counts.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
