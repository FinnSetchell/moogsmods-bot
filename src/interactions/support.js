// Static help text for the public support slash commands. These are pure content
// (no logic), kept out of the interaction dispatcher so the command handler stays
// about routing. handleCommand looks a command name up here and replies with the
// matching embed. To add one: add an entry here + register it in registration.js.

const COLOR = 0x1c3a5e;

export const SUPPORT_EMBEDS = {
  locate: {
    title: '📍 Finding Structures In-Game',
    description: [
      'Use `/locate structure <prefix>:<name>` in-game. Start typing the prefix and Minecraft will auto-complete the available structure names.',
      '',
      '**Mod prefixes:**',
      '`mvs:` — Moog\'s Voyager Structures',
      '`mns:` — Moog\'s Nether Structures',
      '`mes:` — Moog\'s End Structures',
      '`mss:` — Moog\'s Soaring Structures',
      '`mmr:` — Moog\'s Mineshafts Reimagined',
      '',
      '**Example:** `/locate structure mvs:barn`',
      '',
      '> Structures may not be nearby if you\'re playing on a world generated before the mod was installed. Try exploring further or creating a new world.',
    ].join('\n'),
    color: COLOR,
  },

  configpack: {
    title: '⚙️ Config Pack',
    description: [
      'The **config pack** lets you customise structure spawn rates, disable individual structures, change which biomes they appear in, and tweak loot — without modifying the mod itself.',
      '',
      '**How to install:**',
      '1. Download the config pack from CurseForge or Modrinth (listed alongside the mod)',
      '2. Place the `.zip` file (do **not** unzip it) into your world\'s `datapacks` folder:',
      '   - Singleplayer: `<modpack root>/saves/<world name>/datapacks/`',
      '   - Server: `<server root>/world/datapacks/`',
      '3. Run `/reload` in-game or restart your server',
      '4. Edit the JSON files inside the zip to customise settings, then `/reload` again',
      '',
      '> To apply to all worlds, use the [GlobalPacks mod](https://modrinth.com/mod/globalpacks).',
    ].join('\n'),
    color: COLOR,
  },

  mclog: {
    title: '📋 Sharing Your Log',
    description: [
      'Please upload your log to **mclo.gs** and share the link here so we can help.',
      '',
      '**How to find your log:**',
      '- **Latest log:** `<modpack root>/logs/latest.log`',
      '- **Crash report:** `<modpack root>/crash-reports/` (most recent file)',
      '',
      '**How to upload:**',
      '1. Go to <https://mclo.gs>',
      '2. Paste the full log contents',
      '3. Click **Save** and share the link',
      '',
      '> The log contains important error details we need to diagnose your issue.',
    ].join('\n'),
    color: COLOR,
  },

  compatibility: {
    title: '🔗 Terrain Mod Compatibility',
    description: [
      'Moog\'s structure mods use **biome tags** to decide where structures spawn, which means they work with most terrain mods out of the box — no patches needed.',
      '',
      'They match both vanilla and modded convention tags (e.g. `#minecraft:is_forest`, `#c:is_mountain`, `#forge:is_swamp`) — the same tags other mods register their biomes under — so structures automatically appear in those biomes.',
      '',
      'If structures aren\'t spawning in a modded biome, that biome likely isn\'t tagged. You can add it manually using the **config pack** — use `/configpack` for instructions.',
    ].join('\n'),
    color: COLOR,
  },

  versions: {
    title: '🔢 Checking Your Mod Version',
    description: [
      'Check the jar filename in your mods folder — it includes the mod version and Minecraft version.',
      '',
      '**Where to look:**',
      '- `<modpack root>/mods/`',
      '',
      '**Example filename:** `MVS-1.21-5.0.0.jar`',
      'That\'s **MVS version 5.0.0** for **Minecraft 1.21**.',
      '',
      'The Minecraft version in the filename is the **start** of the supported range — a `1.21` build works on **1.21–26.2**, and a `1.20` build works on **1.20–1.20.6**.',
      '',
      'You can also check in-game:',
      '- **Fabric:** open the mods screen (if you have ModMenu installed)',
      '- **Forge/NeoForge:** press `F3+Q` or check the mods button on the main menu',
    ].join('\n'),
    color: COLOR,
  },

  datapack: {
    title: '📦 Installing a Datapack',
    description: [
      'Place the datapack `.zip` (do **not** unzip) into your world\'s `datapacks` folder.',
      '',
      '**Folder location:**',
      '- **Singleplayer:** `<modpack root>/saves/<world name>/datapacks/`',
      '- **Server:** `<server root>/world/datapacks/`',
      '',
      'Then either run `/reload` in-game or restart your server.',
      '',
      'To confirm it loaded: `/datapack list` — it should appear with a green ✔',
      '',
      '> To apply a datapack to **all worlds**, use the [GlobalPacks mod](https://modrinth.com/mod/globalpacks).',
    ].join('\n'),
    color: COLOR,
  },
};
