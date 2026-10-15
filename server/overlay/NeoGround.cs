// SPDX-License-Identifier: GPL-3.0-or-later
//
// Training grounds kept by the server itself. A ground is data/grounds/<name>.json, mounted at
// /app/NeoGrounds (NEO_GROUNDS_DIR): where its creatures live, its start and its rules.
//
//   [NeoGround <name> [player]   set the ground up: clear it of creatures and bodies, put one of
//                                ModernUO's own spawners at every spawn spot (killed creatures come
//                                back by themselves), keep strangers out, and, with a player, bring
//                                that player back at the start after a death, refitted
//   [NeoGround off <name>        take it down: its spawners, what they spawned, the watch
//
// A harness used to do all of this from outside: twenty GM logins to set a ground up, a count of
// every kind every two minutes, strangers removed only once the character could see them, and a
// revive polled from the client's state. Here it is one command and the server's own timers.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using ModernUO.CodeGeneratedEvents;
using Server.Commands;
using Server.Engines.Spawners;
using Server.Items;
using Server.Mobiles;

namespace Server.NeoArena;

public sealed class GroundSpawn
{
    public string Type { get; set; }
    public int[] At { get; set; }
    public int Range { get; set; } = 3;
    public int Count { get; set; } = 1;
    public int Perception { get; set; }
}

public sealed class GroundFile
{
    public string Map { get; set; } = "Felucca";
    public int[] Center { get; set; }
    public int[] Bounds { get; set; }
    public int[] Start { get; set; }
    public int Respawn { get; set; } = 120;
    public int Revive { get; set; } = 30;
    public string Template { get; set; } = "warrior-novice";
    public List<GroundSpawn> Spawns { get; set; } = new();
}

public static class NeoGrounds
{
    private static readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    private sealed class Active
    {
        public string Name;
        public GroundFile File;
        public Map Map;
        public Rectangle2D Area;
        public readonly List<Spawner> Spawners = new();
        public Timer Watch;
        public string Player;
    }

    private static readonly Dictionary<string, Active> _active = new(StringComparer.OrdinalIgnoreCase);

    private static string Folder => ArenaSettings.Env("NEO_GROUNDS_DIR", "/app/NeoGrounds");

    public static void Configure()
    {
        CommandSystem.Register("NeoGround", AccessLevel.GameMaster, OnGround);
    }

    [Usage("NeoGround <name> [player] | NeoGround off <name>")]
    [Description("Sets a training ground up (data/grounds/<name>.json) with spawners, a watch for strangers and revives, or takes it down.")]
    private static void OnGround(CommandEventArgs e)
    {
        if (e.Length < 1)
        {
            Reply(e.Mobile, "error usage: NeoGround <name> [player] | NeoGround off <name>");
            return;
        }

        if (e.GetString(0).InsensitiveEquals("off"))
        {
            var name = e.Length > 1 ? e.GetString(1) : "";
            Reply(e.Mobile, TakeDown(name) ? $"ground off {name}" : $"error no ground {name} is up");
            return;
        }

        var ground = e.GetString(0);
        var file = Load(ground, out var error);
        if (file == null)
        {
            Reply(e.Mobile, $"error {error}");
            return;
        }

        TakeDown(ground);
        var active = SetUp(ground, file, out var cleared, out var creatures);
        active.Player = e.Length > 1 ? e.GetString(1) : null;
        Reply(
            e.Mobile,
            $"ground {ground} spawners {active.Spawners.Count} creatures {creatures} cleared {cleared}" +
            (active.Player != null ? $" revive {active.Player} {file.Revive}s" : "")
        );
    }

    private static GroundFile Load(string name, out string error)
    {
        error = null;
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            error = $"bad ground name {name}";
            return null;
        }

        var path = Path.Combine(Folder, $"{name}.json");
        if (!File.Exists(path))
        {
            error = $"no ground file {path}";
            return null;
        }

        try
        {
            var file = JsonSerializer.Deserialize<GroundFile>(File.ReadAllText(path), _json);
            if (file?.Center is not { Length: 2 } || file.Bounds is not { Length: 4 } || file.Start is not { Length: 2 })
            {
                error = $"{name}: center, bounds and start are needed";
                return null;
            }

            return file;
        }
        catch (JsonException ex)
        {
            error = $"{name}: {ex.Message}";
            return null;
        }
    }

    private static Active SetUp(string name, GroundFile file, out int cleared, out int creatures)
    {
        var map = Map.TryParse(file.Map, null, out var m) && m != null ? m : Map.Felucca;
        int cx = file.Center[0], cy = file.Center[1];
        var area = new Rectangle2D(
            new Point2D(cx + file.Bounds[0], cy + file.Bounds[1]),
            new Point2D(cx + file.Bounds[2] + 1, cy + file.Bounds[3] + 1)
        );
        var active = new Active { Name = name, File = file, Map = map, Area = area };

        // Spawners of this ground left by an earlier server run (they are saved with the world).
        var doomed = new List<IEntity>();
        foreach (var item in map.GetItemsInBounds(area))
        {
            if (item is Spawner s && s.Name == SpawnerName(name) || item is Corpse)
            {
                doomed.Add(item);
            }
        }

        foreach (var mob in map.GetMobilesInBounds<BaseCreature>(area))
        {
            if (!mob.Controlled && !mob.Summoned)
            {
                doomed.Add(mob);
            }
        }

        cleared = doomed.Count;
        foreach (var entity in doomed)
        {
            entity.Delete();
        }

        creatures = 0;
        var delay = TimeSpan.FromSeconds(Math.Max(10, file.Respawn));
        foreach (var spawn in file.Spawns)
        {
            if (spawn.At is not { Length: 2 } || AssemblyHandler.FindTypeByName(spawn.Type) == null)
            {
                continue;
            }

            var spawner = new Spawner(spawn.Count, delay / 2, delay, 0, default) { Name = SpawnerName(name) };
            var x = cx + spawn.At[0];
            var y = cy + spawn.At[1];
            spawner.MoveToWorld(new Point3D(x, y, map.GetAverageZ(x, y)), map);
            spawner.HomeRange = Math.Clamp(spawn.Range, 0, 30);
            spawner.AddEntry(spawn.Type, 100, spawn.Count, false, spawn.Perception > 0 ? $"RangePerception {spawn.Perception}" : null);
            spawner.Respawn();
            active.Spawners.Add(spawner);
            creatures += spawn.Count;
        }

        active.Watch = Timer.DelayCall(TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10), () => RemoveStrangers(active));
        _active[name] = active;
        return active;
    }

    private static string SpawnerName(string ground) => $"neo ground {ground}";

    // Creatures the world's own spawners sent into the ground, or that wandered in.
    private static void RemoveStrangers(Active active)
    {
        List<BaseCreature> strangers = null;
        foreach (var mob in active.Map.GetMobilesInBounds<BaseCreature>(active.Area))
        {
            if (mob.Controlled || mob.Summoned || mob.Spawner is Spawner s && active.Spawners.Contains(s))
            {
                continue;
            }

            (strangers ??= new List<BaseCreature>()).Add(mob);
        }

        if (strangers == null)
        {
            return;
        }

        foreach (var mob in strangers)
        {
            mob.Delete();
        }
    }

    private static bool TakeDown(string name)
    {
        if (!_active.Remove(name, out var active))
        {
            return false;
        }

        active.Watch?.Stop();
        foreach (var spawner in active.Spawners)
        {
            spawner.Delete(); // its creatures go with it
        }

        return true;
    }

    // A death on a ground with a player named: back at its start, refitted, after the ground's delay.
    [OnEvent(nameof(PlayerMobile.PlayerDeathEvent))]
    public static void OnPlayerDeathEvent(PlayerMobile pm)
    {
        foreach (var active in _active.Values)
        {
            if (active.Player == null || !pm.Name.InsensitiveEquals(active.Player))
            {
                continue;
            }

            Timer.DelayCall(TimeSpan.FromSeconds(Math.Max(1, active.File.Revive)), () => Bring(pm, active));
            return;
        }
    }

    private static void Bring(PlayerMobile pm, Active active)
    {
        if (pm.Deleted || pm.Alive || !_active.ContainsKey(active.Name))
        {
            return;
        }

        // As [NeoTemplate does: the template first (it empties the pack and dresses), then Prep, which heals
        // and restocks the pack from it. The other way round left a revived fighter without bandages.
        pm.Resurrect();
        var template = NeoTemplates.Load(active.File.Template, out _);
        if (template != null)
        {
            NeoTemplates.Apply(pm, template);
        }

        ArenaCommands.Prep(pm);

        var x = active.File.Center[0] + active.File.Start[0];
        var y = active.File.Center[1] + active.File.Start[1];
        pm.MoveToWorld(new Point3D(x, y, active.Map.GetAverageZ(x, y)), active.Map);
    }

    private static void Reply(Mobile to, string text) => to.SendMessage($"NEO {text}");
}
