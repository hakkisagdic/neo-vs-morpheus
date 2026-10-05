import { describe, expect, it } from "vitest";
import { readTrainingLog } from "../src/fleet/training.ts";

describe("readTrainingLog", () => {
  it("reads the epochs done, the planned number, the pace and the held-out agreement", () => {
    const log = [
      "Fetching 5 files: 100%|██████████| 5/5\rdevice mps | fp32 | mode top | 64545 items",
      "before: held-out agreement with teacher 0.322, soft CE 2.078",
      "epoch 1/4: train soft CE 1.502 | held-out agreement 0.581, soft CE 1.311 (5400 s)",
      "epoch 2/4: train soft CE 1.204 | held-out agreement 0.613, soft CE 1.250 (10850 s)",
    ].join("\n");
    expect(readTrainingLog(log)).toEqual({ epoch: 2, epochs: 4, seconds: 10850, before: 0.322, agreement: 0.613, saved: false });
  });

  it("knows a log that has not finished an epoch, and a saved checkpoint", () => {
    expect(readTrainingLog("before: held-out agreement with teacher 0.300, soft CE 2.0")).toMatchObject({ epoch: 0, epochs: undefined, before: 0.3 });
    expect(readTrainingLog("epoch 4/4: x | held-out agreement 0.700, soft CE 1 (100 s)\nsaved training/checkpoints/neo-duel-v9b").saved).toBe(true);
  });
});
