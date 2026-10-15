#!/usr/bin/env python3
"""What changed upstream since the last look: Laya (its releases, the PyPI package, Convai's models on
Hugging Face) and TypeSafe's SDK, the client of Jev, whose new versions show new question types; and
the tools the project is built on, against what this machine and deps.lock use (ModernUO, SosariaAI,
Navrey, TazUO, ClassicUO, Ollama, MLflow, Node, .NET):

    python3 lab/upstream.py            # prints what is new, then remembers it as seen
    python3 lab/upstream.py --peek     # prints, remembers nothing
    python3 lab/upstream.py --tools    # every tool: what we use, the newest, how far behind

The last look is kept in .fleet/upstream.json. Release notes are searched for the words that would
change this project's plans (images, boxes, training, routing); this repository serves laya 0.3.20,
because 0.4.0 changed the router. Public APIs only, standard library only.
"""
import argparse
import json
import os
import re
import subprocess
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


def pinned(name):
    """A source's commit in deps.lock."""
    with open(os.path.join(ROOT, "deps.lock")) as f:
        for line in f:
            parts = line.split()
            if parts and parts[0] == name:
                return parts[1]
    return None


def local(cmd):
    """A local tool's version, e.g. `ollama --version`; None when it is not installed."""
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"\d+\.\d+(?:\.\d+)?", out)
    return m.group(0) if m else None


def tools():
    """{tool: {"ours": ..., "newest": ..., "behind": ...}} for the tools the project is built on."""
    out = {}

    def safe(name, fn):
        try:
            out[name] = fn()
        except Exception as e:  # one tool's API down must not hide the others
            out[name] = {"error": f"{type(e).__name__}"}

    def commits_behind(repo, pin, branch="main"):
        c = get(f"https://api.github.com/repos/{repo}/compare/{pin}...{branch}")
        ahead = c.get("ahead_by", 0)
        return {"ours": pin[:7], "newest": c["commits"][-1]["sha"][:7] if c.get("commits") else pin[:7],
                "behind": f"{ahead} commits" if ahead else "up to date"}

    def release(repo):
        return get(f"https://api.github.com/repos/{repo}/releases/latest")["tag_name"].lstrip("v")

    safe("ModernUO", lambda: commits_behind("modernuo/ModernUO", pinned("modernuo")))
    safe("SosariaAI", lambda: commits_behind("PikkonMG/SosariaAI", pinned("sosariaai")))
    safe("Navrey (johnpwrs)", lambda: {"newest": get("https://api.github.com/repos/johnpwrs/navrey/commits?per_page=1")[0]["commit"]["committer"]["date"][:10]})
    safe("TazUO", lambda: {"newest": release("PlayTazUO/TazUO")})
    safe("ClassicUO", lambda: {"newest": release("ClassicUO/ClassicUO")})
    safe("Ollama", lambda: {"ours": local(["ollama", "--version"]), "newest": release("ollama/ollama")})
    safe("MLflow", lambda: {"ours": local([os.path.join(ROOT, ".mlflow", "bin", "python"), "-c", "import mlflow; print(mlflow.__version__)"]),
                           "newest": pypi("mlflow")})
    safe("Node", lambda: {"ours": local(["node", "--version"]),
                         "newest": next(r["version"].lstrip("v") for r in get("https://nodejs.org/dist/index.json") if r.get("lts"))})
    safe(".NET SDK", lambda: {"ours": local(["dotnet", "--version"]),
                             "newest": get("https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/10.0/releases.json")["latest-sdk"]})
    for v in out.values():
        if "ours" in v and "newest" in v and "behind" not in v:
            v["behind"] = "up to date" if v["ours"] and v["newest"] and v["newest"].startswith(v["ours"]) else "update available"
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--peek", action="store_true", help="do not remember this look")
    ap.add_argument("--tools", action="store_true", help="every tool, what we use against the newest")
    args = ap.parse_args()
    seen = json.load(open(SEEN)) if os.path.exists(SEEN) else {}
    now = {"laya_releases": laya_releases(), "laya_pypi": pypi("laya"), "typesafe_sdk": pypi("typesafe-sdk"), "convai_models": convai_models(),
           "tools": tools()}
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
    for tool, v in now["tools"].items():
        if v.get("newest") and v.get("newest") != seen.get("tools", {}).get(tool, {}).get("newest") and v.get("behind") != "up to date":
            news.append(f"{tool}: newest {v['newest']}" + (f", we use {v['ours']}" if v.get("ours") else "") + (f" ({v['behind']})" if v.get("behind") else ""))
    if args.tools:
        for tool, v in now["tools"].items():
            print(f"{tool:20} " + ", ".join(f"{k} {val}" for k, val in v.items()))
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
