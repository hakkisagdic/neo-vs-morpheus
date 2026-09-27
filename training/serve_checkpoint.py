#!/usr/bin/env python3
"""Serve a local Laya checkpoint (e.g. one made by finetune.py) through the official laya-serve.

laya-serve only knows the published checkpoints by name, so this points the "typed-decisions"
name at a local directory before the server builds its router. Same API: POST /v1/systemone.

    usage: serve_checkpoint.py <checkpoint-dir>    (host/port from LAYA_HOST / LAYA_PORT)
"""
import os
import sys

import laya.router as router

path = os.path.abspath(sys.argv[1])
if not os.path.exists(os.path.join(path, "rl_agent_config.json")):
    sys.exit(f"{path} is not a Laya checkpoint (no rl_agent_config.json)")
router.DEFAULT_MODELS["typed-decisions"] = (path, None)

from laya import serve  # noqa: E402  (after the patch above)

serve.main()
