#!/usr/bin/env python3
"""What changed upstream since the last look: Laya (its releases, the PyPI package, Convai's models on
Hugging Face) and TypeSafe's SDK, the client of Jev, whose new versions show new question types:

    python3 lab/upstream.py            # prints what is new, then remembers it as seen
    python3 lab/upstream.py --peek     # prints, remembers nothing

The last look is kept in .fleet/upstream.json. Release notes are searched for the words that would
change this project's plans (images, boxes, training, routing); this repository serves laya 0.3.20,
because 0.4.0 changed the router. Public APIs only, standard library only.
"""
import argparse
import json
import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEEN = os.path.join(ROOT, ".fleet", "upstream.json")
WATCH = re.compile(r"image|vision|multimodal|bounding|\bbox\b|bbox|train|fine-?tun|router|tournament|calibrat|checkpoint|onnx|speed|latency",
                   re.I)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "laya-uo-bot upstream check", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def laya_releases():
    out = {}
    for r in get("https://api.github.com/repos/NandhaKishorM/laya/releases?per_page=20"):
        notes = [l.strip("* ").split(" by @")[0] for l in (r.get("body") or "").splitlines() if l.startswith("*")]
        out[r["tag_name"]] = {"date": r["published_at"][:10], "notable": [n for n in notes if WATCH.search(n)][:8]}
    return out


def pypi(name):
    return get(f"https://pypi.org/pypi/{name}/json")["info"]["version"]


def convai_models():
    models = get("https://huggingface.co/api/models?author=convaiinnovations&sort=lastModified&direction=-1&limit=30")
    return {m["id"]: m.get("lastModified", "")[:10] for m in models}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--peek", action="store_true", help="do not remember this look")
    args = ap.parse_args()
    seen = json.load(open(SEEN)) if os.path.exists(SEEN) else {}
    now = {"laya_releases": laya_releases(), "laya_pypi": pypi("laya"), "typesafe_sdk": pypi("typesafe-sdk"), "convai_models": convai_models()}
    news = []
    for tag, r in sorted(now["laya_releases"].items(), key=lambda kv: kv[1]["date"]):
        if tag not in seen.get("laya_releases", {}):
            news.append(f"Laya {tag} ({r['date']})" + (": " + "; ".join(r["notable"]) if r["notable"] else ": nothing on images, boxes, training or routing"))
    for key, label in (("laya_pypi", "laya on PyPI"), ("typesafe_sdk", "typesafe-sdk (Jev's client) on PyPI")):
        if now[key] != seen.get(key):
            news.append(f"{label}: {seen.get(key, 'first look')} -> {now[key]}")
    for model, date in now["convai_models"].items():
        if seen.get("convai_models", {}).get(model) != date:
            news.append(f"Convai model {model} updated {date}" if model in seen.get("convai_models", {}) else f"Convai model {model} ({date})")
    print("\n".join(news) if seen else f"first look: laya {now['laya_pypi']}, typesafe-sdk {now['typesafe_sdk']}, "
          f"{len(now['laya_releases'])} Laya releases, {len(now['convai_models'])} Convai models")
    if seen and not news:
        print("nothing new upstream")
    if not args.peek:
        os.makedirs(os.path.dirname(SEEN), exist_ok=True)
        with open(SEEN, "w") as f:
            json.dump(now, f, indent=1)


if __name__ == "__main__":
    main()
