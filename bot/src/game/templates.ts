// Character templates (templates/<id>.json at the repository root). The server applies them
// ([NeoTemplate: stats, skills, gear, consumables, spellbooks, tithing points); the bot reads which
// decision module a template plays with, and which skill its trainee trains.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleName } from "../brain/types.ts";
import type { TrainSkill } from "./train-brain.ts";

export type TemplateInfo = {
  id: string;
  title: string;
  modules: ModuleName[];
  /** The spells in the template's book (the bot's keys, e.g. "magicArrow"); none: the whole book. */
  spells?: string[];
  /** Of those, the ones offered in a fight (a profile: a nuker, a stun mage...); none: the default list. */
  offer?: string[];
  /** The skill a trainee of this template trains in a skill session; none: Magery. */
  train?: TrainSkill;
};

const TRAIN_SKILLS: readonly string[] = ["magery", "necromancy", "chivalry"];

const DIR = join(import.meta.dirname, "..", "..", "..", "templates");

export function loadTemplate(id: string): TemplateInfo {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`bad template name ${id}`);
  }
  let t: Partial<TemplateInfo>;
  try {
    t = JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")) as Partial<TemplateInfo>;
  } catch (err) {
    if (id === "mage") {
      return { id, title: "PvP mage", modules: ["mage"] }; // the server's built-in mage
    }
    throw new Error(`no template ${id} in templates/ (${(err as Error).message})`);
  }
  if (t.train !== undefined && !TRAIN_SKILLS.includes(t.train)) {
    throw new Error(`template ${id} trains ${t.train}; one of ${TRAIN_SKILLS.join(", ")}`);
  }
  return { id, title: t.title ?? id, modules: t.modules?.length ? t.modules : ["mage"], spells: t.spells, offer: t.offer, ...(t.train ? { train: t.train } : {}) };
}

/** The decision module a template's fighter uses. */
export const moduleOf = (id: string): ModuleName => loadTemplate(id).modules[0];
