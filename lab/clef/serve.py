#!/usr/bin/env python3
"""Serve Cloudflare's Clef (or Clef-flash) on this Mac through the System One API, as laya-serve
serves Laya, so that the bot can ask it as a teacher or play it in UO Bench:

    .laya/venv/bin/python lab/clef/serve.py .clef/clef-flash --port 8200

POST /v1/systemone with {"state": ..., "questions": {...}} is answered by the weights' own code
(joint_schema_model.py's systemone(), Apache-2.0): every option scored in one forward pass, the
answer in Jev's form. The model's name is the folder's ("clef-flash"). Standard library server,
one request at a time (one GPU).
"""
import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import torch


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="the downloaded weights (hf download Cloudflare/clef-flash --local-dir ...)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8200)
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    ap.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    args = ap.parse_args()

    path = os.path.abspath(args.path)
    name = os.path.basename(path.rstrip("/"))
    sys.path.insert(0, path)
    from joint_schema_model import load_release_model, systemone  # noqa: E402  (the release's own code)

    started = time.time()
    model, processor = load_release_model(path, device=args.device, dtype=getattr(torch, args.dtype))
    print(f"{name} on {args.device} ({args.dtype}) loaded in {time.time() - started:.0f} s", flush=True)
    gpu = Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path.rstrip("/") not in ("/v1/systemone", "/api/v1/decisions"):
                self.send_error(404)
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                body["model"] = name  # whatever the caller named, this server answers with its own
                t0 = time.perf_counter()
                with gpu:
                    out = json.dumps(systemone(model, processor, body)).encode()
                ms = (time.perf_counter() - t0) * 1000
                code = 200
            except Exception as err:  # a bad request is answered with its reason; the server stays up
                out, ms, code = json.dumps({"error": repr(err)}).encode(), 0.0, 400
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("x-inference-time-ms", f"{ms:.1f}")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):  # quiet: the bot logs what it asks
            pass

    print(f"System One on http://{args.host}:{args.port}/v1/systemone", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
