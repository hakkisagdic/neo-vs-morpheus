// The arena's obstacles. [NeoArena places stone wall blocks (item 0x0080), which the server's
// synthetic tiledata marks as walls: they block walking and line of sight (server/Dockerfile,
// server/overlay/NeoArena.cs).
export const OBSTACLE_GRAPHICS: ReadonlySet<number> = new Set([0x0080]);

export const ARENA_LAYOUTS = ["open", "pillars", "wall", "ring"] as const;
export type ArenaLayout = (typeof ARENA_LAYOUTS)[number];
