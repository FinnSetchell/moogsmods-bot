# Staff Guide — Keeping the Docs Up To Date

The bot maintains a pinned staff guide embed in the staff guidelines channel.
The embed is built from the `sendDocs()` function in `src/index.js`.

**After adding or changing any feature, update `sendDocs()` then refresh the message:**

```powershell
# Reads WORKER_API_KEY from .dev.vars (gitignored) — same pattern as register.ps1 / test-*.ps1
$key = (Get-Content (Join-Path $PSScriptRoot ".dev.vars") | Where-Object { $_ -match '^WORKER_API_KEY=' } | Select-Object -First 1).Split('=', 2)[1].Trim()
Invoke-RestMethod -Uri "https://moogsmods-bot.finndog176.workers.dev/send-docs" -Method Post -Headers @{"X-API-Key"=$key}
```

> The key must never be hardcoded here. If you run this from a saved `.ps1`, `$PSScriptRoot`
> resolves to that script's folder; when pasting interactively, replace it with the repo path.

This will PATCH the existing message (same message ID, no re-pin needed).

## What triggers an update

| Change | Action needed |
|---|---|
| New context menu command | Add a new embed section in `sendDocs()` |
| New slash command | Register it in `registerCommands()` **and** document it in `sendDocs()` (see "Public support commands" below) |
| New modal field | Update the relevant embed description/fields |
| Channel or role reassignment | Update via env vars in Cloudflare dashboard — `sendDocs()` reads them at call time |
| Feature removed | Remove or update the relevant embed section in `sendDocs()` |

## Public support commands

These are **public** slash commands (any member can run them, not admin-only). Each replies
with a help embed so staff can answer common questions with a single command. Definitions live
in the public-commands handler in `src/index.js`; they are registered in `registerCommands()`
and summarised in the "💬 Public Support Commands" embed section of `sendDocs()`.

| Command | What it explains |
|---|---|
| `/locate` | Finding structures in-game via `/locate structure <prefix>:<name>` (with the mod prefix list) |
| `/configpack` | Installing and using the config pack to customise spawn rates, biomes, and loot |
| `/mclog` | Finding and sharing a log via mclo.gs for support |
| `/versions` | Checking which mod version is installed (jar filename / in-game) |
| `/datapack` | Where to install a datapack `.zip` and how to confirm it loaded |
| `/compatibility` | How Moog's mods use vanilla and modded biome tags for terrain-mod compatibility |

When adding another public command, update three places: the handler in `src/index.js`, the
`registerCommands()` array, and both the table above and the `sendDocs()` embed.

## Channel / role env vars used in the embed

| Env var | Purpose |
|---|---|
| `CHANNEL_REVIEW` | Where review cards are posted |
| `CHANNEL_ANNOUNCEMENTS` | Major release channel |
| `CHANNEL_MINOR` | Minor release channel |
| `CHANNEL_ALPHA` | Alpha/test builds channel |
| `ROLE_MAJOR` | @mod-announcements role |
| `ROLE_MINOR` | @minor-mod-announcements role |
| `ROLE_ALPHA` | @play-test-volunteer role |
| `LOG_CHANNEL` (constant) | Moderation log — `1131312070755893268` |
| `DOCS_CHANNEL` (constant) | Staff guide channel — `1118598313709682769` |

The docs message ID is stored in KV under `docs_message_id`.
