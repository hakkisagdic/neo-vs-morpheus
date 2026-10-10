// The System One backends a brain can ask, as the configuration names them: Laya (laya-serve),
// Jev (FreeJev or TypeSafe), or the random pick that needs no server.
import { config, requireSetting } from "../config.ts";
import type { Backend } from "./systemone.ts";

/** "laya-b": the second Laya server, which serves another checkpoint (a sparring partner, a ladder). */
export function modelBackend(kind: Backend["name"] | "laya-b"): Backend {
  switch (kind) {
    case "laya":
    case "laya-b":
      return {
        name: "laya",
        url: kind === "laya-b" ? config.layaUrlB : config.layaUrl,
        apiKey: config.layaApiKey || undefined,
        model: "typed-decisions",
        timeoutMs: 20_000, // CPU-only in Docker on macOS: seconds, not milliseconds
      };
    case "random":
      return { name: "random", url: "" };
    case "clef":
      // A 9B (Clef-flash) or 27B (Clef) model on this Mac's GPU: hundreds of milliseconds, not tens.
      return { name: "clef", url: config.clefUrl, timeoutMs: 30_000 };
    case "jev":
      return {
        name: "jev",
        url: config.jevUrl,
        path: config.jevPath,
        apiKey: requireSetting(config.jevApiKey, "JEV_API_KEY"),
        model: config.jevModel || undefined,
        timeoutMs: 15_000,
      };
  }
}
