// SPDX-License-Identifier: GPL-3.0-or-later
//
// neo-vs-morpheus arena helpers. server/Dockerfile copies this folder into ModernUO's
// Projects/UOContent/NeoArena before building, so it compiles as part of UOContent and
// upstream stays untouched. Being linked into ModernUO, this file is GPL-3.0 like it.
//
// Everything here is driven by environment variables (see docker-compose.yml) and by
// GM commands that the bot's orchestrator sends as speech:
//
//   [NeoPrep <name>                         resurrect, heal, cure, restock one player
//   [NeoDuel <nameA> <nameB> [distance]     prep both and face them off in the arena
//   [NeoPlace <name> <west|east> [distance] prep one player and put them on one side
//   [NeoTemplate <name> [skill] [stats]     GM mage template (skip leveling for PvP tests)
//   [NeoMage [type] [distance]              spawn an NPC caster on the east side
//   [NeoClear [radius]                      delete NPCs and corpses around the arena
//   [NeoArena <open|pillars|wall>           set the arena's obstacles

using System;
using System.Collections.Generic;
using Server.Accounting;
using Server.Commands;
using Server.Items;
using Server.Logging;
using Server.Misc;
using Server.Mobiles;
using Server.Network;

namespace Server.NeoArena;

public static class ArenaSettings
{
    private static string _mapName = "Felucca";

    // Resolved on use: map definitions are not registered yet while Configure runs.
    public static Map Map => Map.TryParse(_mapName, null, out var map) && map != null ? map : Map.Felucca;

    public static Point2D Center { get; private set; }
    public static int ReagentAmount { get; private set; }

    public static void Configure()
    {
        _mapName = Env("NEO_ARENA_MAP", "Felucca");
        Center = new Point2D(EnvInt("NEO_ARENA_X", 1180), EnvInt("NEO_ARENA_Y", 3610));
        ReagentAmount = EnvInt("NEO_REAGENTS", 200);
    }

    public static string Env(string name, string fallback)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    public static int EnvInt(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var value) ? value : fallback;
}

public static class ArenaBootstrap
{
    private static readonly ILogger logger = LogFactory.GetLogger(typeof(ArenaBootstrap));

    // AccountPrompt.Initialize (default priority 50) asks on the console for an owner account
    // when none exists, which throws on a headless (container) boot. Creating the owner from
    // the environment first keeps the first boot unattended.
    [CallPriority(40)]
    public static void Initialize()
    {
        if (Accounts.Count > 0)
        {
            return;
        }

        var username = Environment.GetEnvironmentVariable("NEO_OWNER_USER");
        var password = Environment.GetEnvironmentVariable("NEO_OWNER_PASS");

        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrEmpty(password))
        {
            logger.Warning("NEO_OWNER_USER/NEO_OWNER_PASS are not set; no owner account was created");
            return;
        }

        var account = new Account(username.Trim(), password)
        {
            AccessLevel = AccessLevel.Owner
        };

        ServerAccess.AddProtectedAccount(account, true);
        logger.Information("Owner account {Username} created from the environment", account.Username);
    }
}

public static class ArenaCommands
{
    private static readonly SkillName[] MageSkills =
    [
        SkillName.Magery,
        SkillName.EvalInt,
        SkillName.Meditation,
        SkillName.MagicResist,
        SkillName.Wrestling,
        SkillName.Inscribe,
        SkillName.Poisoning
    ];

    public static void Configure()
    {
        CommandSystem.Register("NeoPrep", AccessLevel.GameMaster, OnPrep);
        CommandSystem.Register("NeoDuel", AccessLevel.GameMaster, OnDuel);
        CommandSystem.Register("NeoPlace", AccessLevel.GameMaster, OnPlace);
        CommandSystem.Register("NeoTemplate", AccessLevel.GameMaster, OnTemplate);
        CommandSystem.Register("NeoMage", AccessLevel.GameMaster, OnMage);
        CommandSystem.Register("NeoClear", AccessLevel.GameMaster, OnClear);
        CommandSystem.Register("NeoArena", AccessLevel.GameMaster, OnArena);
    }

    // West and east spots `distance` tiles apart, centered on the arena.
    private static (int West, int East) Spots(int distance)
    {
        var west = ArenaSettings.Center.X - distance / 2;
        return (west, west + distance);
    }

    private static int Distance(CommandEventArgs e, int index) =>
        Math.Clamp(e.Length > index ? e.GetInt32(index) : 8, 1, 18);

    [Usage("NeoPrep <name>")]
    [Description("Resurrects, heals, cures and restocks an online player (full spellbook, reagents).")]
    private static void OnPrep(CommandEventArgs e)
    {
        var target = FindOnline(e.Mobile, e.GetString(0));
        if (target == null)
        {
            return;
        }

        Prep(target);
        Reply(e.Mobile, $"prep {target.Name} 0x{target.Serial.Value:X8}");
    }

    [Usage("NeoDuel <nameA> <nameB> [distance]")]
    [Description("Preps two online players and places them facing each other in the arena.")]
    private static void OnDuel(CommandEventArgs e)
    {
        var a = FindOnline(e.Mobile, e.GetString(0));
        var b = FindOnline(e.Mobile, e.GetString(1));
        if (a == null || b == null)
        {
            return;
        }

        var (west, east) = Spots(Distance(e, 2));
        var y = ArenaSettings.Center.Y;

        Prep(a);
        Prep(b);
        Place(a, west, y);
        Place(b, east, y);

        a.Direction = a.GetDirectionTo(b);
        b.Direction = b.GetDirectionTo(a);

        Reply(
            e.Mobile,
            $"duel {a.Name} 0x{a.Serial.Value:X8} {a.X},{a.Y},{a.Z} " +
            $"{b.Name} 0x{b.Serial.Value:X8} {b.X},{b.Y},{b.Z} {ArenaSettings.Map.Name}"
        );
    }

    [Usage("NeoPlace <name> <west|east> [distance]")]
    [Description("Preps one online player and places them on one side of the arena.")]
    private static void OnPlace(CommandEventArgs e)
    {
        var target = FindOnline(e.Mobile, e.GetString(0));
        if (target == null)
        {
            return;
        }

        var (west, east) = Spots(Distance(e, 2));
        Prep(target);
        Place(target, e.GetString(1).InsensitiveEquals("east") ? east : west, ArenaSettings.Center.Y);
        Reply(e.Mobile, $"place {target.Name} 0x{target.Serial.Value:X8} {target.X},{target.Y},{target.Z}");
    }

    [Usage("NeoClear [radius=20]")]
    [Description("Deletes NPCs and corpses around the arena, between rounds.")]
    private static void OnClear(CommandEventArgs e)
    {
        var radius = Math.Clamp(e.Length > 0 ? e.GetInt32(0) : 20, 1, 60);
        var map = ArenaSettings.Map;
        var center = new Point3D(ArenaSettings.Center.X, ArenaSettings.Center.Y, 0);

        var doomed = new List<IEntity>();
        foreach (var creature in map.GetMobilesInRange<BaseCreature>(center, radius))
        {
            doomed.Add(creature);
        }

        foreach (var corpse in map.GetItemsInRange<Corpse>(center, radius))
        {
            doomed.Add(corpse);
        }

        foreach (var entity in doomed)
        {
            entity.Delete();
        }

        Reply(e.Mobile, $"clear {doomed.Count}");
    }

    // Obstacles are stone wall blocks. server/Dockerfile gives item 0x0080 its real tiledata
    // entry (Wall, Impassable, NoShoot, 20 high) in the synthetic data, so the blocks stop
    // walking and line of sight as walls do on the real map.
    public const int ObstacleGraphic = 0x0080;
    private const string ObstacleName = "neo arena obstacle";

    // Offsets from the arena centre. The start spots lie on the centre row, west and east.
    private static readonly Dictionary<string, (int X, int Y)[]> Layouts = new()
    {
        ["open"] = [],
        // Cover to either side of the line between the start spots.
        ["pillars"] = [(-3, -2), (3, -2), (-3, 2), (3, 2)],
        // Across the middle, open at both ends: no straight line from one start to the other.
        ["wall"] = [(0, -2), (0, -1), (0, 0), (0, 1), (0, 2)],
    };

    [Usage("NeoArena <open|pillars|wall>")]
    [Description("Removes the arena's obstacles and places those of the given layout.")]
    private static void OnArena(CommandEventArgs e)
    {
        var name = e.Length > 0 ? e.GetString(0).ToLowerInvariant() : "open";
        if (!Layouts.TryGetValue(name, out var layout))
        {
            Reply(e.Mobile, $"error unknown layout {name}; one of {string.Join(", ", Layouts.Keys)}");
            return;
        }

        var map = ArenaSettings.Map;
        var center = new Point3D(ArenaSettings.Center.X, ArenaSettings.Center.Y, 0);
        var old = new List<Item>();
        foreach (var item in map.GetItemsInRange<Static>(center, 30))
        {
            if (item.Name == ObstacleName)
            {
                old.Add(item);
            }
        }

        foreach (var item in old)
        {
            item.Delete();
        }

        foreach (var (dx, dy) in layout)
        {
            var block = new Static(ObstacleGraphic) { Name = ObstacleName };
            block.MoveToWorld(new Point3D(center.X + dx, center.Y + dy, 0), map);
        }

        Reply(e.Mobile, $"arena {name} {layout.Length}");
    }

    [Usage("NeoTemplate <name> [skill=100] [str=90 dex=35 int=100]")]
    [Description("Sets a PvP mage template: Magery, Eval Int, Meditation, Resist, Wrestling, Inscription, Poisoning.")]
    private static void OnTemplate(CommandEventArgs e)
    {
        var target = FindOnline(e.Mobile, e.GetString(0));
        if (target == null)
        {
            return;
        }

        var skill = Math.Clamp(e.Length > 1 ? e.GetInt32(1) : 100, 0, 120);
        foreach (var name in MageSkills)
        {
            target.Skills[name].Base = skill;
        }

        if (e.Length > 4)
        {
            target.RawStr = Math.Clamp(e.GetInt32(2), 10, 125);
            target.RawDex = Math.Clamp(e.GetInt32(3), 10, 125);
            target.RawInt = Math.Clamp(e.GetInt32(4), 10, 125);
        }
        else
        {
            target.RawStr = 90;
            target.RawDex = 35;
            target.RawInt = 100;
        }

        Prep(target);
        Reply(e.Mobile, $"template {target.Name} skill {skill} stats {target.RawStr}/{target.RawDex}/{target.RawInt}");
    }

    [Usage("NeoMage [type=EvilMageLord] [distance=8]")]
    [Description("Spawns an NPC caster east of the arena center as an opponent.")]
    private static void OnMage(CommandEventArgs e)
    {
        var typeName = e.Length > 0 ? e.GetString(0) : "EvilMageLord";
        var type = AssemblyHandler.FindTypeByName(typeName);

        if (type == null || !typeof(BaseCreature).IsAssignableFrom(type))
        {
            Reply(e.Mobile, $"error unknown creature type {typeName}");
            return;
        }

        if (type.CreateInstance<BaseCreature>() is not { } creature)
        {
            Reply(e.Mobile, $"error cannot create {typeName}");
            return;
        }

        var (_, east) = Spots(Distance(e, 1));
        var y = ArenaSettings.Center.Y;
        creature.Home = new Point3D(east, y, 0);
        creature.RangeHome = 4;
        Place(creature, east, y);

        Reply(e.Mobile, $"mage {creature.Name} 0x{creature.Serial.Value:X8} {creature.X},{creature.Y},{creature.Z}");
    }

    public static void Prep(Mobile m)
    {
        if (!m.Alive)
        {
            m.Resurrect();
        }

        if (m is PlayerMobile { Young: true } pm)
        {
            (pm.Account as Account)?.RemoveYoungStatus(0);
        }

        m.Poison = null;
        m.Paralyzed = false;
        m.Frozen = false;

        // StatMods is null until the mobile has had one
        if (m.StatMods is { Count: > 0 } mods)
        {
            foreach (var mod in new List<StatMod>(mods))
            {
                m.RemoveStatMod(mod.Name);
            }
        }

        m.Hits = m.HitsMax;
        m.Mana = m.ManaMax;
        m.Stam = m.StamMax;
        m.Combatant = null;
        m.Warmode = false;

        Restock(m);
    }

    private static void Restock(Mobile m)
    {
        var pack = m.Backpack;
        if (pack == null)
        {
            pack = new Backpack { Movable = false };
            m.AddItem(pack);
        }

        var stale = new List<Item>();
        foreach (var reagent in pack.FindItemsByType<BaseReagent>())
        {
            stale.Add(reagent);
        }

        // Every resurrection dresses the player in a new death robe and the old ones pile up in
        // the pack: after a few hundred rounds, 136 robes (408 stones) left the bots too heavy to
        // run more than one step.
        foreach (var robe in pack.FindItemsByType<DeathRobe>())
        {
            stale.Add(robe);
        }

        foreach (var item in stale)
        {
            item.Delete();
        }

        var amount = ArenaSettings.ReagentAmount;
        pack.DropItem(new BlackPearl(amount));
        pack.DropItem(new Bloodmoss(amount));
        pack.DropItem(new Garlic(amount));
        pack.DropItem(new Ginseng(amount));
        pack.DropItem(new MandrakeRoot(amount));
        pack.DropItem(new Nightshade(amount));
        pack.DropItem(new SpidersSilk(amount));
        pack.DropItem(new SulfurousAsh(amount));

        var book = Spellbook.FindRegular(m);
        if (book == null)
        {
            pack.DropItem(new Spellbook(ulong.MaxValue));
        }
        else
        {
            book.Content = ulong.MaxValue;
        }
    }

    private static void Place(Mobile m, int x, int y)
    {
        var map = ArenaSettings.Map;
        m.MoveToWorld(new Point3D(x, y, map.GetAverageZ(x, y)), map);
    }

    private static Mobile FindOnline(Mobile from, string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            Reply(from, "error missing player name");
            return null;
        }

        foreach (var ns in NetState.Instances)
        {
            if (ns.Mobile is { } m && m.Name.InsensitiveEquals(name))
            {
                return m;
            }
        }

        Reply(from, $"error {name} is not online");
        return null;
    }

    // Machine-readable replies for the orchestrator: every line starts with "NEO ".
    private static void Reply(Mobile to, string text) => to.SendMessage($"NEO {text}");
}
