# Tools

What the project runs on, what it adopts next and what it passed over. The open-source scan of
15 October 2026 behind the "next" and "passed over" lists checked each tool's license, activity and
fit; versions are that week's. See ARCHITECTURE.md for how the pieces fit.

## In use

| Area | Tool | For | Where |
|---|---|---|---|
| Game server | [ModernUO](https://github.com/modernuo/ModernUO) (GPL-3.0) | the shard: arena lanes and the real world | pinned in `deps.lock`; our commands in `server/overlay/`; image `ghcr.io/hakkisagdic/laya-modernuo` (`.github/workflows/server-image.yml`, `scripts/server-image.sh`); `lab/world.sh` |
| Game client | Navrey (BSD-2-Clause), our fork [hakkisagdic/navrey](https://github.com/hakkisagdic/navrey), branch `laya` | the real game with a window, driven by files | `lab/navrey.sh` |
| Bot client | our headless TypeScript client | duels at volume, gates, benchmarks | `bot/` |
| Client files | EA's Ultima Online Classic | maps, art, tiles | `~/UO/client`; private HF dataset `hakkisagdic/laya-uo-client` |
| Game facts | our readers of ModernUO's source and EA's files | creatures (`lab/bestiary.py`), places (`lab/poi.py`), the ground itself (`lab/terrain.py`) | `data/` |
| Fast decisions | [Laya](https://github.com/NandhaKishorM/laya) 0.3.20 (Apache-2.0) | every fight move, ~40 ms | `training/serve_checkpoint.py`; pinned in `deps.lock` |
| Teacher | Jev, through FreeJev | labels for distillation | `lab/teacher.py`, `bot/src/distill/` |
| Strategist | Gemma 4 (26B MoE, 31B dense) and gpt-oss 120B through [Ollama](https://github.com/ollama/ollama); Claude through Claude Code | whole sessions with game tools | `lab/uo_agent.py` |
| Training | Hugging Face Transformers fine-tuning | Laya checkpoints | `training/finetune.py`; Colab Pro+ (`training/colab.py`), Kaggle (`training/kaggle.py`); `lab/trainer.py` |
| Model store | Hugging Face private repos | checkpoints as tags, datasets | `training/publish_hf.py` |
| Tracking | [MLflow](https://github.com/mlflow/mlflow) (local) | every training and gate run | `.fleet/mlflow`, `lab/track.py`; the `mlflow` MCP server |
| Promotion | our gate and UO Bench | a candidate keeps every skill the champion trains | `lab/trainer.py`, `lab/test_gate.py`, `bench/`, `docs/BENCH.md` |
| Fleet | Docker lanes on the Mac, alastyr, Colab | matches at volume | `lab/keeper.py`, `bot/src/fleet/` |
| Upkeep | launchd and session crons | lossless compression, unused checkpoints, Docker's old cache; upstream releases | `lab/tidy.py` (04:00), `lab/upstream.py` (09:17) |
| Tests and CI | vitest (bot), unittest (lab), GitHub Actions | every push | `.github/workflows/ci.yml` |

## Next, in this order (approved 15 October 2026)

1. **Lineage.** MLflow `log_input` with `from_huggingface(..., revision=)` and HF model-card metadata
   (`datasets:`, `base_model:`): which labels made which model.
2. **Label quality.** [cleanlab](https://github.com/cleanlab/cleanlab) 2.9 (Apache-2.0):
   `find_label_issues` on out-of-fold Laya probabilities finds bad teacher labels; Datalab finds
   near-duplicate states leaking between train and validation.
3. **Tracing the strategist.** MLflow Tracing (`mlflow.openai.autolog()` through Ollama's OpenAI
   endpoint, tool calls included); `mlflow.genai.evaluate` scorers for sessions.
4. **A sequential gate.** SPRT as chess engines test (OpenBench, pentanomial), paired matches (same
   seed, sides swapped), [arena-rank](https://github.com/lmarena/arena-rank) confidence intervals.
5. **Hyperparameter search.** [Optuna](https://github.com/optuna/optuna) 5 ask-and-tell from the
   Mac, trials as nested MLflow runs.

Then: Laya 0.4 (calibration, abstention: "not sure, ask the strategist"); ONNX Runtime int8 on
the CPU-only lanes. Also from the scan: runs as zstd Parquet ([DuckDB](https://github.com/duckdb/duckdb))
in HF Storage Buckets, for the Hub quota (the disk side is done: APFS compression took the runs
from 118.5 GB to 9.5 GB); coverage.py and Hypothesis for the Python tests.

## Studying (forked 15 October 2026)

- [TazUO](https://github.com/PlayTazUO/TazUO) (BSD-2-Clause), fork
  [hakkisagdic/TazUO](https://github.com/hakkisagdic/TazUO), `~/Projects/TazUO`: a ClassicUO fork
  with Python scripting built in; a candidate base for our macOS client and agent bridge.
- [SosariaAI](https://github.com/PikkonMG/SosariaAI) (GPL-3.0), fork
  [hakkisagdic/SosariaAI](https://github.com/hakkisagdic/SosariaAI), `~/Projects/SosariaAI`: a
  ModernUO plugin with server-side player bots (rules and an optional small decision model); a
  candidate for our server image.

## Later

Inspect AI (scenario suites for the strategist), Label Studio (reviewing flagged decisions),
Evidently (drift, once live play starts), DVC, MLX and Ettin encoders (a smaller, faster Laya),
llama.cpp server (if Ollama's tool calls break), vLLM (batch strategist evals on Colab's GPU),
openskill.py, savvi, Sphere Source-X (the Sphere stage), UOFiddler and CentrED#, Neural MMO and
PufferLib (if a duel simulator is ever written).

## Passed over

| Tool | Why |
|---|---|
| Langfuse | self-hosting needs six services; owned by ClickHouse since January 2026 |
| Arize Phoenix | Elastic License 2.0; only if MLflow falls short |
| OpenLLMetry | owned by ServiceNow since March 2026; MLflow covers it |
| Argilla, NannyML, whylogs | inactive, sold or their service shut down |
| Oxen, lakeFS, Ray Tune | servers and schedulers this setup does not need |
| Core ML Tools | conversion work for little gain at ~40 ms |
| RF-DETR, YOLO | the protocol already gives exact state; YOLO is AGPL |
| Stealth, UOSteam, EasyUO, OrionUO | closed, Windows-only or unmaintained |

## Keeping current

- `deps.lock` pins the upstream sources we build from (ModernUO, Laya); `scripts/deps.sh sync`
  checks them out, `scripts/deps.sh backup` keeps offline bundles.
- `lab/upstream.py` checks Laya's releases, PyPI (`laya`, `typesafe-sdk`) and Convai's models
  every morning against `.fleet/upstream.json`.
- The server image is rebuilt on GitHub whenever the overlay changes; its tag carries the ModernUO
  commit and the overlay's hash.
