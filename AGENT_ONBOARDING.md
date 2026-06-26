# Workspace Onboarding — Moog's Mods

You are working in **Finn Setchell's "Moog's Mods" workspace** — a suite of Minecraft structure mods plus an automated Discord-gated release pipeline. Read this before doing anything, then read `HANDOFF.md` (current session state) and `AGENT_RELEASE_MIGRATION.md` (release-system migration ledger), both in `C:\Users\finn\moogsmods-bot\`.

## What this workspace is

- A family of Minecraft mods published to **CurseForge + Modrinth**: MNS (Nether), MVS (Voyager), MES (End), MSS (Soaring), MMR (Mineshafts Reimagined), MTR (Temples Reimagined), MBS (Bountiful), MMV (Missing Villages), MVSI (Voyager Integrated); plus libraries (`MoogsStructureLib`) and tools (`UpdateBeacon`). GitHub orgs: `FinnSetchell` and `Moog-s-Mods`.
- An automated release pipeline driven by a **Cloudflare Worker** (`C:\Users\finn\moogsmods-bot\src\index.js`, deployed at `moogsmods-bot.finndog176.workers.dev`) + **GitHub Actions** + **Discord**.

## Repo layout (`C:\Users\finn\IdeaProjects\`)

- Mods are checked out as **sibling directories, one per MC line**: e.g. `MoogsNetherStructures2` (branch `1.21-datapack`) and `MoogsNetherStructures2-1.20-datapack` (branch `1.20-datapack`) are the **same GitHub repo**, different branches. Directory names do not always match their checked-out branch — always confirm with `git -C <dir> rev-parse --abbrev-ref HEAD` and `git remote get-url origin`.
- Some dirs are **different remotes/orgs** (e.g. `Moog-s-Mods/MoogsVoyagerStructures` vs `FinnSetchell/MoogsVoyagerStructures-Integrated`). `ModBeacon*` dirs are the **same repo as `UpdateBeacon`**.
- **Do NOT edit** ephemeral/scratch copies: anything under `<repo>\.claude\worktrees\*` (Claude worktrees) or `…\migration\…\staged\*` (staged migration copies).
- Many third-party mods are also cloned here (BiomesOPlenty, tectonic, C2ME, etc.) — not Moog's; leave them alone unless asked.

## Release flow

```
tag push  →  release.yml: extract changelog, post Discord review card (~10s)
          →  user approves in Discord
          →  Worker dispatches the repo's publish.yml
          →  build → publish CurseForge/Modrinth → GitHub Release → POST /published
          →  Worker sends the Discord announcement (only after a successful publish)
```

Three workflow patterns exist — identify which before changing release files:
- **Pattern A (central, the target):** `release.yml` + `publish.yml` both delegate to `FinnSetchell/release-actions/.github/workflows/*.yml@v1`; `build.gradle` has **no** `discord {}` block.
- **Pattern B (local Worker):** MMR only — local `release.yml`/`publish.yml` that call the Worker directly.
- **OLD self-contained (legacy):** one `release.yml` doing validate→build→publish→announce inline, where the gradle `discord {}` block **is the live announcement mechanism**. Removing the block here breaks announcements unless you migrate the whole workflow. Migration recipe: `AGENT_RELEASE_MIGRATION.md`.

`gradle.properties` drives everything: `minecraftVersion` (→ branch `<ver>-datapack`), `modVersion`, `publishMcStart`/`publishMcEnd`/`publishExtraMcVersions`, `publishDisplayPrefix`/`publishDisplaySuffix`, `curseforgeProjectSlug`, `modrinthProjectSlug`, `discordAvatarUrl`/`discordBannerUrl`/`discordEmbedColor`/`discordThumbnailUrl`. If `modrinthProjectSlug` is missing the Worker defaults to the MNS slug (wrong links) — always set it. `CHANGELOG.md` uses `## [version] - YYYY-MM-DD` sections (parsed by the changelog extractor).

## Conventions & gotchas (read these — they will bite you otherwise)

1. **Never commit or push without explicit user approval.** Stage specific files, not `git add -A`.
2. **The mod repos' `commit-msg` hook rejects `Co-Authored-By:` trailers** — omit them. Do **not** bypass hooks with `--no-verify`.
3. **Environment is Windows + PowerShell** (Bash also available). A `jcodemunch` read-guard hook **blocks the `Grep` tool and `Bash` grep/cat/etc. globally** — use the **PowerShell tool** (`Select-String`, `Get-ChildItem`) or the **Read** tool instead.
4. **Mixed LF/CRLF** across `build.gradle` files — preserve each file's existing EOL when editing programmatically, or you'll produce whole-file diffs.
5. **Non-fast-forward pushes are common:** GitHub Actions auto-pushes a `Post-release: bump … + stub CHANGELOG` commit to release branches, so local checkouts are often 1 behind. `git fetch` then `git rebase origin/<branch>` before pushing.
6. **Secrets:** GitHub repo secrets are `WORKER_API_KEY`, `MODRINTH_API_KEY`, `CURSEFORGE_API_KEY`. Locally, `WORKER_API_KEY` lives in `C:\Users\finn\moogsmods-bot\.dev.vars` (gitignored, untracked); `register.ps1` and `test-*.ps1` read it automatically. **Never print secret values or write them into tracked files.**
7. **Quick build validation:** `./gradlew help --offline` confirms a `build.gradle` still configures (the discord-block bug surfaced during Gradle's configuration phase).

## Key files

| What | Where |
|------|-------|
| Cloudflare Worker source | `C:\Users\finn\moogsmods-bot\src\index.js` |
| Register Discord commands | `C:\Users\finn\moogsmods-bot\register.ps1` (reads `.dev.vars`) |
| Bot staff guide | `C:\Users\finn\moogsmods-bot\STAFF_GUIDE.md` |
| Release-system migration recipe + ledger | `C:\Users\finn\moogsmods-bot\AGENT_RELEASE_MIGRATION.md` |
| Current session state | `C:\Users\finn\moogsmods-bot\HANDOFF.md` |
| Central release workflows | GitHub `FinnSetchell/release-actions` (not local) |

**Start by reading `HANDOFF.md` for what's in flight, then ask the user what they want to tackle.**
