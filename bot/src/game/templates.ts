// Character templates (templates/<id>.json at the repository root). The server applies them
// ([NeoTemplate: stats, skills, gear, consumables); the bot reads which decision module a
// template plays with.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleName } from "../brain/types.ts";

export type TemplateInfo = {
  id: string;
  title: string;
  modules: ModuleName[];
  /** The spells in the template's book (the bot's keys, e.g. "magicArrow"); none: the whole book. */
  spells?: string[];
  /** Of those, the ones offered in a fight (a profile: a nuker, a stun mage...); none: the default list. */
  offer?: string[];
};

const DIR = join(import.meta.dirname, "..", "..", "..", "templates");

export function loadTemplate(id: string): TemplateInfo {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`bad template name ${id}`);
  }
  try {
    const t = JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as Partial<TemplateInfo>;
    return { id, title: t.title ?? id, modules: t.modules?.length ? t.modules : ["mage"], spells: t.spells, offer: t.offer };
  } catch (err) {
    if (id === "mage") {
      return { id, title: "PvP mage", modules: ["mage"] }; // the server's built-in mage
    }
    throw new Error(`no template ${id} in templates/ (${(err as Error).message})`);
  }
}

/** The decision module a template's fighter uses. */
export const moduleOf = (id: string): ModuleName => loadTemplate(id).modules[0];
