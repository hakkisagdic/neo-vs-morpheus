// SPDX-License-Identifier: GPL-3.0-or-later
//
// Character templates as data. templates/<id>.json in the repository (mounted at
// NEO_TEMPLATES_DIR, default /app/NeoTemplates) names a build's stats, skills, the items it
// wears and the consumables it carries. [NeoTemplate applies one to a player; every prep then
// restocks that template's consumables and puts back any gear that went missing.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Server.Items;

namespace Server.NeoArena;

public sealed class NeoTemplate
{
    public string Id { get; set; } = "mage";
    public Dictionary<string, int> Stats { get; set; } = new();
    public Dictionary<string, int> Skills { get; set; } = new();
    public string[] Wear { get; set; } = [];
    public Dictionary<string, int> Pack { get; set; } = new();
    public bool Spellbook { get; set; }
}

public static class NeoTemplates
{
    private static readonly Dictionary<Serial, NeoTemplate> _assigned = new();
    private static readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    private static string Folder => ArenaSettings.Env("NEO_TEMPLATES_DIR", "/app/NeoTemplates");

    // Used when no template files are mounted: the mage every bot started as.
    private static NeoTemplate BuiltInMage()
    {
        var amount = ArenaSettings.ReagentAmount;
        return new NeoTemplate
        {
            Id = "mage",
            Stats = new Dictionary<string, int> { ["str"] = 90, ["dex"] = 35, ["int"] = 100 },
            Skills = new Dictionary<string, int>
            {
                ["Magery"] = 100, ["EvalInt"] = 100, ["Meditation"] = 100, ["MagicResist"] = 100,
                ["Wrestling"] = 100, ["Inscribe"] = 100, ["Poisoning"] = 100
            },
            Pack = new Dictionary<string, int>
            {
                ["BlackPearl"] = amount, ["Bloodmoss"] = amount, ["Garlic"] = amount, ["Ginseng"] = amount,
                ["MandrakeRoot"] = amount, ["Nightshade"] = amount, ["SpidersSilk"] = amount, ["SulfurousAsh"] = amount
            },
            Spellbook = true
        };
    }

    /// <summary>Reads templates/&lt;id&gt;.json; null with a reason when it cannot.</summary>
    public static NeoTemplate Load(string id, out string error)
    {
        error = null;
        if (id.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            error = $"bad template name {id}";
            return null;
        }

        var path = Path.Combine(Folder, $"{id}.json");
        if (!File.Exists(path))
        {
            if (id.Equals("mage", StringComparison.OrdinalIgnoreCase))
            {
                return BuiltInMage();
            }

            error = $"no template {id} in {Folder}";
            return null;
        }

        try
        {
            var template = JsonSerializer.Deserialize<NeoTemplate>(File.ReadAllText(path), _json);
            template.Id = id;
            return template;
        }
        catch (Exception ex)
        {
            error = $"template {id}: {ex.Message}";
            return null;
        }
    }

    public static NeoTemplate Of(Mobile m) => _assigned.TryGetValue(m.Serial, out var t) ? t : BuiltInMage();

    /// <summary>Sets stats and skills, swaps the gear, remembers the template for later preps. Returns problems, if any.</summary>
    public static List<string> Apply(Mobile m, NeoTemplate t)
    {
        var problems = new List<string>();
        m.RawStr = Math.Clamp(t.Stats.GetValueOrDefault("str", 50), 10, 125);
        m.RawDex = Math.Clamp(t.Stats.GetValueOrDefault("dex", 50), 10, 125);
        m.RawInt = Math.Clamp(t.Stats.GetValueOrDefault("int", 50), 10, 125);

        for (var i = 0; i < m.Skills.Length; i++)
        {
            m.Skills[i].Base = 0;
        }

        foreach (var (name, value) in t.Skills)
        {
            if (Enum.TryParse<SkillName>(name, true, out var skill))
            {
                m.Skills[skill].Base = Math.Clamp(value, 0, 120);
            }
            else
            {
                problems.Add($"unknown skill {name}");
            }
        }

        // Weapons and armour of another build come off; the template's own go on.
        var wanted = new HashSet<string>(t.Wear, StringComparer.OrdinalIgnoreCase);
        foreach (var item in new List<Item>(m.Items))
        {
            if (item is BaseWeapon or BaseArmor && !wanted.Contains(item.GetType().Name))
            {
                item.Delete();
            }
        }

        // A new build starts with an empty pack: another template's potions or spellbook would linger.
        if (m.Backpack != null)
        {
            foreach (var item in new List<Item>(m.Backpack.Items))
            {
                item.Delete();
            }
        }

        _assigned[m.Serial] = t;
        problems.AddRange(Dress(m, t));
        foreach (var name in t.Pack.Keys)
        {
            if (Create(name) is { } probe)
            {
                probe.Delete();
            }
            else
            {
                problems.Add($"unknown item {name}");
            }
        }

        return problems;
    }

    /// <summary>Fresh consumables for the mobile's template, its spellbook, and any gear it lost.</summary>
    public static void Restock(Mobile m)
    {
        var t = Of(m);
        var pack = m.Backpack;
        if (pack == null)
        {
            pack = new Backpack { Movable = false };
            m.AddItem(pack);
        }

        var packTypes = new HashSet<string>(t.Pack.Keys, StringComparer.OrdinalIgnoreCase);
        var stale = new List<Item>();
        foreach (var item in pack.FindItemsByType<Item>())
        {
            // Every resurrection dresses the player in a new death robe and the old ones pile up
            // in the pack: after a few hundred rounds, 136 robes (408 stones) left the bots too
            // heavy to run more than one step.
            if (item is BaseReagent or DeathRobe || packTypes.Contains(item.GetType().Name))
            {
                stale.Add(item);
            }
        }

        foreach (var item in stale)
        {
            item.Delete();
        }

        foreach (var (name, amount) in t.Pack)
        {
            for (var left = amount; left > 0;)
            {
                var item = Create(name, left);
                if (item == null)
                {
                    break;
                }

                item.LootType = LootType.Blessed;
                if (item.Stackable)
                {
                    item.Amount = left;
                    left = 0;
                }
                else
                {
                    left--;
                }

                pack.DropItem(item);
            }
        }

        if (t.Spellbook)
        {
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

        Dress(m, t);
    }

    // Puts on whatever of the template's gear is not worn yet, blessed so that death keeps it.
    private static List<string> Dress(Mobile m, NeoTemplate t)
    {
        var problems = new List<string>();
        foreach (var name in t.Wear)
        {
            var worn = false;
            foreach (var item in m.Items)
            {
                if (item.GetType().Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                {
                    worn = true;
                    break;
                }
            }

            if (worn)
            {
                continue;
            }

            var gear = Create(name);
            if (gear == null)
            {
                problems.Add($"unknown item {name}");
                continue;
            }

            gear.LootType = LootType.Blessed;
            m.FindItemOnLayer(gear.Layer)?.Delete();
            if (!m.EquipItem(gear))
            {
                problems.Add($"cannot wear {name}");
                gear.Delete();
            }
        }

        return problems;
    }

    // Items by class name. Many take an optional amount ("Bandage(int amount = 1)"), which is not a
    // parameterless constructor as far as reflection is concerned.
    private static Item Create(string name, int amount = 1)
    {
        var type = AssemblyHandler.FindTypeByName(name);
        if (type == null || !typeof(Item).IsAssignableFrom(type) || type.IsAbstract)
        {
            return null;
        }

        foreach (var ctor in type.GetConstructors().OrderBy(c => c.GetParameters().Length))
        {
            var parameters = ctor.GetParameters();
            if (!parameters.All(p => p.IsOptional))
            {
                continue;
            }

            var args = parameters
                .Select(p => p.ParameterType == typeof(int) && p.Name == "amount" ? amount : p.DefaultValue)
                .ToArray();
            try
            {
                return ctor.Invoke(args) as Item;
            }
            catch
            {
                // try the next constructor
            }
        }

        return null;
    }
}
