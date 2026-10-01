// Consumables and weapons a fighter carries: what they look like on the wire, what they cost, and
// how to use them. Graphics, abilities and timings follow ModernUO (UOContent/Items).
import type { TargetCursor } from "../world/world.ts";
import * as out from "../uo/outgoing.ts";
import type { Session } from "./session.ts";

export const GRAPHIC = {
  bandage: 0x0e21,
  healPotion: 0x0f0c,
  curePotion: 0x0f07,
  refreshPotion: 0x0f0b,
  explosionPotion: 0x0f0d,
  arrow: 0x0f3f,
  bolt: 0x1bfb,
} as const;

export type Consumable = keyof typeof GRAPHIC;

/** ModernUO's WeaponAbility.Abilities index, base mana, and a short description for the model. */
export const ABILITIES = {
  armorIgnore: { index: 1, mana: 30, text: "ignores armour" },
  bleedAttack: { index: 2, mana: 30, text: "makes them bleed" },
  concussionBlow: { index: 3, mana: 25, text: "damage from their missing health" },
  crushingBlow: { index: 4, mana: 25, text: "a heavy hit" },
  disarm: { index: 5, mana: 20, text: "knocks their weapon away" },
  doubleStrike: { index: 7, mana: 30, text: "two swings at once" },
  infectiousStrike: { index: 8, mana: 15, text: "poisons them" },
  mortalStrike: { index: 9, mana: 30, text: "stops their healing for a while" },
  paralyzingBlow: { index: 11, mana: 30, text: "paralyzes them for a moment" },
  whirlwindAttack: { index: 13, mana: 15, text: "hits everyone around" },
} as const;

export type AbilityName = keyof typeof ABILITIES;

export type Weapon = {
  name: string;
  ranged: boolean;
  /** Takes both hands: no potions (they need a free hand). */
  twoHanded: boolean;
  /** Tiles from which it hits. */
  range: number;
  primary: AbilityName;
  secondary: AbilityName;
  ammo?: Consumable;
  /** ModernUO's MlSpeed: the swing delay in seconds before stamina and speed bonuses. */
  mlSpeed: number;
};

/** Weapons by graphic (only those the templates use, and a few common ones). */
export const WEAPONS: Record<number, Weapon> = {
  0x13ff: { name: "katana", ranged: false, twoHanded: false, range: 1, primary: "doubleStrike", secondary: "armorIgnore", mlSpeed: 2.5 },
  0x0f5e: { name: "broadsword", ranged: false, twoHanded: false, range: 1, primary: "crushingBlow", secondary: "armorIgnore", mlSpeed: 3.25 },
  0x0f61: { name: "longsword", ranged: false, twoHanded: false, range: 1, primary: "armorIgnore", secondary: "concussionBlow", mlSpeed: 3.5 },
  0x1401: { name: "kryss", ranged: false, twoHanded: false, range: 1, primary: "armorIgnore", secondary: "infectiousStrike", mlSpeed: 2 },
  0x1405: { name: "war fork", ranged: false, twoHanded: false, range: 1, primary: "bleedAttack", secondary: "disarm", mlSpeed: 2.5 },
  0x143e: { name: "halberd", ranged: false, twoHanded: true, range: 2, primary: "whirlwindAttack", secondary: "concussionBlow", mlSpeed: 4.25 },
  0x13b2: { name: "bow", ranged: true, twoHanded: true, range: 10, primary: "paralyzingBlow", secondary: "mortalStrike", ammo: "arrow", mlSpeed: 4.25 },
  0x0f50: { name: "crossbow", ranged: true, twoHanded: true, range: 8, primary: "concussionBlow", secondary: "mortalStrike", ammo: "bolt", mlSpeed: 4.5 },
};

/**
 * Time between two swings under ML rules (BaseWeapon.GetDelay): 4 ticks of 0.25 s per second of
 * MlSpeed, one tick less for every 30 stamina, never under 5 ticks. A bow at 100 stamina: 14 ticks,
 * 3.5 s; a katana: 7 ticks, 1.75 s.
 */
export function swingDelayMs(weapon: Weapon, stam: number): number {
  const ticks = Math.max(5, Math.floor(weapon.mlSpeed * 4 - Math.floor(stam / 30)));
  return ticks * 250;
}

/** Under SE rules and later an archer shoots only after standing still this long (BaseRanged.OnSwing). */
export const STAND_STILL_MS = 250;

/** Shields by graphic: one in hand leaves no hand free for potions. */
export const SHIELDS = new Set([0x1b72, 0x1b73, 0x1b74, 0x1b76, 0x1b78, 0x1b7a, 0x1b7b, 0x1bc3, 0x1bc4]);

/** Whether the player has a hand free to drink or throw a potion. */
export function freeHand(session: Session): boolean {
  const { world } = session;
  for (const item of world.items.values()) {
    if (item.container === world.playerSerial && (SHIELDS.has(item.graphic) || WEAPONS[item.graphic]?.twoHanded)) {
      return false;
    }
  }
  return true;
}

/**
 * Mana an ability costs: 10 less when Swords, Macing, Fencing, Archery, Parry (and a few others)
 * add up to 300, 5 less from 200. A second ability within 3 s costs double; the caller tracks that.
 */
export function abilityMana(name: AbilityName, combatSkillTotal: number): number {
  const base = ABILITIES[name].mana;
  return base - (combatSkillTotal >= 300 ? 10 : combatSkillTotal >= 200 ? 5 : 0);
}

/** Seconds a bandage on oneself takes at a given Dexterity (ModernUO, AOS rules). */
export const selfBandageSeconds = (dex: number) => 5 + 0.5 * ((120 - dex) / 10);

/** A Greater Heal potion can be drunk once every 10 s. */
export const HEAL_POTION_DELAY_MS = 10_000;

/** Items in the player's backpack, stacks summed, by graphic. */
export function packCount(session: Session, graphic: number): number {
  const { world } = session;
  let n = 0;
  for (const item of world.items.values()) {
    if (item.graphic === graphic && item.container === world.backpack) {
      n += item.amount;
    }
  }
  return n;
}

function packItem(session: Session, graphic: number): number | null {
  const { world } = session;
  for (const item of world.items.values()) {
    if (item.graphic === graphic && item.container === world.backpack) {
      return item.serial;
    }
  }
  return null;
}

/** The weapon in the player's hands, if the templates know it. */
export function wielded(session: Session, serial = session.world.playerSerial): Weapon | null {
  for (const item of session.world.items.values()) {
    if (item.container === serial && WEAPONS[item.graphic]) {
      return WEAPONS[item.graphic];
    }
  }
  return null;
}

export type UseResult = "used" | "none" | "refused" | "timeout";

/**
 * Double-clicks an item from the backpack and, when a target cursor follows (bandages, explosion
 * potions), answers it. It worked when the stack shrank: the server consumes an item as it is
 * used, and says no in many ways ("You must have a free hand to drink a potion", "You must wait
 * 10 seconds", ...), so the count is the one reliable signal.
 */
export function useItem(
  session: Session,
  graphic: number,
  target: { kind: "self" } | { kind: "mobile"; serial: number } | null,
): Promise<UseResult> {
  const { client, world } = session;
  const serial = packItem(session, graphic);
  if (serial === null) {
    return Promise.resolve("none");
  }
  const before = packCount(session, graphic);
  const consumed = () => packCount(session, graphic) < before;
  if (world.target) {
    client.send(out.cancelTarget(world.target.id));
    world.target = null;
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: UseResult) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      world.off("target", onTarget);
      resolve(r);
    };
    const onTarget = (cursor: TargetCursor) => {
      if (!target) {
        client.send(out.cancelTarget(cursor.id));
        world.target = null;
        return finish("refused");
      }
      const who = target.kind === "self" ? world.playerSerial : target.serial;
      const m = world.mobiles.get(who);
      client.send(out.targetObject(cursor.id, cursor.flags, who, m?.x ?? 0, m?.y ?? 0, m?.z ?? 0, m?.body ?? 0));
      world.target = null;
    };
    const poll = setInterval(() => {
      if (consumed()) {
        finish("used");
      }
    }, 50);
    const timer = setTimeout(() => finish(consumed() ? "used" : "refused"), target ? 2_000 : 800);
    world.on("target", onTarget);
    client.send(out.doubleClick(serial));
  });
}

/** Arms a weapon ability for the next swing (index 0 clears it). */
export function setAbility(session: Session, ability: AbilityName | null): void {
  session.client.send(out.setAbility(session.world.playerSerial, ability ? ABILITIES[ability].index : 0));
}
