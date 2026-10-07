// The System One backends a brain can ask, as the configuration names them: Laya (laya-serve),
// Jev (FreeJev or TypeSafe), or the random pick that needs no server.
import { config, requireSetting } from "../config.ts";
import type { Backend } from "./systemone.ts";

export function modelBackend(kind: Backend["name"]): Backend {
  switch (kind) {
    case "laya":
      return {
        name: "laya",
        url: config.layaUrl,
        apiKey: config.layaApiKey || undefined,
        model: "typed-decisions",
        timeoutMs: 20_000, // CPU-only in Docker on macOS: seconds, not milliseconds
      };
    case "random":
      return { name: "random", url: "" };
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
