# Agent Instructions: Migrate Mod Repo to New Release System

These instructions tell you exactly what to change in a Minecraft mod repo to use the updated release pipeline. Apply them to every branch that has its own `release.yml`.

## What Changed (Background)

The old release flow:
1. Tag push → compile Java → send Discord review card
2. Approve → trigger publish.yml → publish to CF/MR → send Discord announcement immediately

The new release flow:
1. Tag push → extract changelog only (no Java, ~10 s) → send Discord review card
2. Approve → trigger publish.yml → build + publish to CF/MR → Worker sends Discord announcement only after success

Key changes:
- The `discord { ... }` block inside `publishMods {}` in `build.gradle` is removed. The Cloudflare Worker handles all Discord announcements. Having this block caused `UnsupportedOperationException` during Gradle's configuration phase.
- `release.yml` uses a lightweight `changelog` job instead of a full `build` job. Review cards post in ~10 s instead of ~2 min.
- `publish.yml` no longer passes `-x announceDiscord` (the task no longer exists once the discord block is removed).

---

## Step 1 — Identify the workflow type

Check `.github/workflows/release.yml`. There are two patterns:

**Pattern A — Central (most mods like MNS, MES, MVS, MSS):**
```yaml
jobs:
  release:
    uses: FinnSetchell/release-actions/.github/workflows/release.yml@v1
    with: ...
```
These repos delegate to the central `release-actions` repo. The central workflows are already updated. You only need to fix `build.gradle`.

**Pattern B — Local workflows (MMR — `MoogsMineshaftsReimagined` and its 1.20 sibling):**
The `release.yml` and `publish.yml` are defined locally. Both workflow files AND `build.gradle` need updating.

---

## Step 2 — Fix `build.gradle` (ALL repos, both patterns)

Find the `discord { ... }` block inside the `publishMods { }` closure and **delete it entirely**.

It looks like this (exact content varies per mod):

```groovy
publishMods {
    // ... curseforge/modrinth blocks ...

    discord {                                        // ← DELETE from here
        webhookUrl = System.getenv("DISCORD_WEBHOOK") ?: ""
        setPlatforms(publishMods.platforms.modrinth, publishMods.platforms.curseforge)
        content = changelog.map { text ->
            // ... message building ...
        }
        style {
            look = "MODERN"
            // ...
        }
    }                                               // ← to here (inclusive)
}
```

Delete just the `discord { ... }` block — leave the rest of `publishMods { }` intact.

Also delete any standalone `discordPreview` task if present:
```groovy
tasks.register('discordPreview') {     // ← delete this task entirely
    // ...
}
```

---

## Step 3 — Fix `release.yml` (Pattern B / local workflows only)

> Skip this step for Pattern A repos — the central `release.yml` is already correct.

The `release.yml` should use a lightweight `changelog` job instead of a `build` job. Replace the entire jobs section with:

```yaml
jobs:
  discord:
    name: Discord Review
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set alpha flag from tag
        shell: bash
        run: |
          if echo "${GITHUB_REF_NAME}" | grep -qP '-alpha\.\d+$'; then
            sed -i 's|^alphaBuild=.*$|alphaBuild=true|' gradle.properties
          fi

      - name: Read properties
        id: props
        shell: bash
        run: |
          get() { grep -E "^$1=" gradle.properties | cut -d= -f2 | tr -d ' \r\n' || true; }
          ALPHA=$(get alphaBuild)
          RELEASE_TYPE="minor"
          [ "$ALPHA" = "true" ] && RELEASE_TYPE="alpha"
          echo "releaseType=$RELEASE_TYPE"                   >> "$GITHUB_OUTPUT"
          echo "version=$(get modVersion)"                   >> "$GITHUB_OUTPUT"
          echo "mcVersion=$(get minecraftVersion)"           >> "$GITHUB_OUTPUT"
          echo "mcStart=$(get publishMcStart)"               >> "$GITHUB_OUTPUT"
          echo "mcEnd=$(get publishMcEnd)"                   >> "$GITHUB_OUTPUT"
          echo "avatarUrl=$(get discordAvatarUrl)"           >> "$GITHUB_OUTPUT"
          echo "bannerUrl=$(get discordBannerUrl)"           >> "$GITHUB_OUTPUT"
          echo "color=$(get discordEmbedColor)"              >> "$GITHUB_OUTPUT"
          echo "thumbnailUrl=$(get discordThumbnailUrl)"     >> "$GITHUB_OUTPUT"
          echo "cfSlug=$(get curseforgeProjectSlug)"         >> "$GITHUB_OUTPUT"
          echo "mrSlug=$(get modrinthProjectSlug)"           >> "$GITHUB_OUTPUT"
          echo "displayPrefix=$(get publishDisplayPrefix)"   >> "$GITHUB_OUTPUT"
          echo "displaySuffix=$(get publishDisplaySuffix)"   >> "$GITHUB_OUTPUT"
          MC_VERSION=$(get minecraftVersion)
          echo "branch=${MC_VERSION}-datapack"               >> "$GITHUB_OUTPUT"
          echo "mcExtraRaw=$(get publishExtraMcVersions)"    >> "$GITHUB_OUTPUT"

      - name: Extract Changelog
        id: changelog
        shell: bash
        run: |
          VERSION=$(grep '^modVersion=' gradle.properties | cut -d= -f2 | tr -d ' \r\n')
          BODY=$(python3 -c "
          import re, sys
          content = open('CHANGELOG.md').read()
          m = re.search(r'## \[' + re.escape(sys.argv[1]) + r'\] - \d{4}-\d{2}-\d{2}\r?\n(.*?)(?=\r?\n---|## \[|\Z)', content, re.DOTALL)
          print(m.group(1).strip() if m else '')
          " "$VERSION")
          printf "body<<DELIMITER\n%s\nDELIMITER\n" "$BODY" >> "$GITHUB_OUTPUT"

      - name: Send to Worker
        shell: bash
        env:
          WORKER_API_KEY: ${{ secrets.WORKER_API_KEY }}
          CHANGELOG_RAW: ${{ steps.changelog.outputs.body }}
          MC_EXTRA_RAW: ${{ steps.props.outputs.mcExtraRaw }}
        run: |
          IMAGE_URLS=$(echo "$CHANGELOG_RAW" | grep -oP '!\[.*?\]\(\K[^)]+' | head -4 | jq -R . | jq -sc . 2>/dev/null) || IMAGE_URLS="[]"
          [ -z "$IMAGE_URLS" ] && IMAGE_URLS="[]"
          CLEAN=$(echo "$CHANGELOG_RAW" | sed 's/!\[.*\]([^)]*)//g' | sed '/^[[:space:]]*$/d' | sed -e '${/^$/d}')
          if [ -n "$MC_EXTRA_RAW" ]; then
            MC_EXTRA_JSON=$(echo "$MC_EXTRA_RAW" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | jq -R . | jq -sc .) || MC_EXTRA_JSON="[]"
            [ -z "$MC_EXTRA_JSON" ] && MC_EXTRA_JSON="[]"
          else
            MC_EXTRA_JSON="[]"
          fi
          PAYLOAD=$(jq -n \
            --arg project       "${{ github.repository }}" \
            --arg tag           "${{ github.ref_name }}" \
            --arg branch        "${{ steps.props.outputs.branch }}" \
            --arg configPack    "" \
            --arg javaVersion   "21" \
            --arg modName       "REPLACE_MOD_NAME" \
            --arg version       "${{ steps.props.outputs.version }}" \
            --arg mcVersion     "${{ steps.props.outputs.mcVersion }}" \
            --arg mcStart       "${{ steps.props.outputs.mcStart }}" \
            --arg mcEnd         "${{ steps.props.outputs.mcEnd }}" \
            --arg releaseType   "${{ steps.props.outputs.releaseType }}" \
            --argjson discordPing false \
            --arg cfSlug        "${{ steps.props.outputs.cfSlug }}" \
            --arg mrSlug        "${{ steps.props.outputs.mrSlug }}" \
            --arg bannerUrl     "${{ steps.props.outputs.bannerUrl }}" \
            --arg avatarUrl     "${{ steps.props.outputs.avatarUrl }}" \
            --arg thumbnailUrl  "${{ steps.props.outputs.thumbnailUrl }}" \
            --arg color         "${{ steps.props.outputs.color }}" \
            --arg displayPrefix "${{ steps.props.outputs.displayPrefix }}" \
            --arg displaySuffix "${{ steps.props.outputs.displaySuffix }}" \
            --arg changelog     "$CLEAN" \
            --argjson imageUrls "$IMAGE_URLS" \
            --argjson mcExtra   "$MC_EXTRA_JSON" \
            '{
              project:       $project,
              tag:           $tag,
              branch:        $branch,
              configPack:    $configPack,
              javaVersion:   $javaVersion,
              modName:       $modName,
              version:       $version,
              mcVersion:     $mcVersion,
              mcStart:       $mcStart,
              mcEnd:         $mcEnd,
              mcExtra:       $mcExtra,
              releaseType:   $releaseType,
              discordPing:   $discordPing,
              cfSlug:        $cfSlug,
              mrSlug:        $mrSlug,
              bannerUrl:     $bannerUrl,
              avatarUrl:     $avatarUrl,
              thumbnailUrl:  $thumbnailUrl,
              color:         $color,
              displayPrefix: $displayPrefix,
              displaySuffix: $displaySuffix,
              changelog:     $changelog,
              imageUrls:     $imageUrls
            }')

          HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST https://moogsmods-bot.finndog176.workers.dev/release \
            -H "Content-Type: application/json" \
            -H "X-API-Key: $WORKER_API_KEY" \
            -d "$PAYLOAD")

          echo "Worker responded: $HTTP_CODE"
          if [ "$HTTP_CODE" != "200" ]; then
            echo "::warning::Discord Worker returned $HTTP_CODE — review card may not have posted"
          fi
```

Replace `REPLACE_MOD_NAME` with the actual mod display name (e.g. `"Moogs Mineshafts Reimagined"`).

---

## Step 4 — Fix `publish.yml` (Pattern B / local workflows only)

> Skip this step for Pattern A repos — the central `publish.yml` is already correct.

Two changes:

**4a. Remove `-x announceDiscord`** from the Gradle publish step:

```yaml
# Before:
- name: Publish to CurseForge & Modrinth
  shell: bash
  run: |
    set -eo pipefail
    ./gradlew publishMods -x announceDiscord

# After:
- name: Publish to CurseForge & Modrinth
  shell: bash
  run: |
    set -eo pipefail
    ./gradlew publishMods
```

**4b. Fix changelog backtick expansion** in the "Build release title" step. The changelog body must be passed via an env var, not inlined:

```yaml
# Before:
- name: Build release title
  id: release_meta
  shell: bash
  run: |
    ...
    printf "body<<DELIMITER\n%s\nDELIMITER\n" "${{ steps.changelog.outputs.body }}" >> "$GITHUB_OUTPUT"

# After:
- name: Build release title
  id: release_meta
  shell: bash
  env:
    CHANGELOG_BODY: ${{ steps.changelog.outputs.body }}
  run: |
    ...
    printf "body<<DELIMITER\n%s\nDELIMITER\n" "$CHANGELOG_BODY" >> "$GITHUB_OUTPUT"
```

Also add `DISCORD_WEBHOOK: "skip"` to the publish step env block as a safety net:
```yaml
- name: Publish to CurseForge & Modrinth
  shell: bash
  run: |
    set -eo pipefail
    ./gradlew publishMods
  env:
    MODRINTH_API_KEY: ${{ secrets.MODRINTH_API_KEY }}
    CURSEFORGE_API_KEY: ${{ secrets.CURSEFORGE_API_KEY }}
    DISCORD_WEBHOOK: "skip"
```

---

## Step 5 — Commit and push

For each branch you've modified, commit with a message like:
```
fix(release): remove discord block from publishMods; lightweight release workflow
```

Do NOT push tags — only push the branch commits. The user will tag when ready to release.

---

## Verification checklist

After applying changes to a branch:
- [ ] `build.gradle`: no `discord { }` block inside `publishMods { }`, no `discordPreview` task
- [ ] `.github/workflows/release.yml`: no `build` job that runs `./gradlew build`; posts review card directly (Pattern A: delegates to central; Pattern B: `discord` job with no `needs:`)
- [ ] `.github/workflows/publish.yml` (Pattern B only): no `-x announceDiscord`; `CHANGELOG_BODY` env var used in title step; `DISCORD_WEBHOOK: "skip"` in publish step env

---

## Reference: already-updated repos

These are already on the new system — use them as examples if needed:
- `MoogsMineshaftsReimagined` (branch `1.21-datapack`) — Pattern B, fully updated
- `MoogsMineshaftsReimagined` (branch `1.20-datapack`) — Pattern B, fully updated
- `FinnSetchell/release-actions` — central workflows, already updated
- `UpdateBeacon` (all 5 branches) — central workflows, already updated

Pattern A (central) repos — `build.gradle` `discord {}` block + `discordPreview` task removed (2026-06-26):
- `MoogsBountifulStructures` (branch `1.21-datapack`)
- `MoogsEndStructures` (branch `1.21-datapack`)
- `MoogsMissingVillages` (branch `1.21-datapack`)
- `MoogsNetherStructures2` (branch `1.21-datapack`)
- `MoogsNetherStructures2` (branch `1.20-datapack`)
- `MoogsSoaringStructures` (branch `1.21-datapack`)
- `MoogsTemplesReimagined` (branch `1.20-datapack`)
- `MoogsVoyagerStructures` (branch `1.20-datapack`)

Fully migrated OLD-flow → central Worker flow (replaced `release.yml`, added `publish.yml`, removed discord block, added `modrinthProjectSlug`) (2026-06-26):
- `FinnSetchell/MoogsBountifulStructures` (branch `1.20-datapack`)
- `FinnSetchell/MoogsEndStructures` (branch `1.20-datapack`)
- `FinnSetchell/MoogsMissingVillages` (branch `1.20-datapack`)
- `FinnSetchell/MoogsSoaringStructures` (branch `1.20-datapack`)
- `FinnSetchell/MoogsTemplesReimagined` (branch `1.21-datapack`)
- `Moog-s-Mods/MoogsVoyagerStructures` (branch `1.21-datapack`)

> Still on the OLD self-contained flow (discord block is LIVE — needs full workflow migration, not just block removal):
> - `FinnSetchell/MoogsVoyagerStructures-Integrated` (`1.21-datapack`) — blocked: repo is missing the `WORKER_API_KEY` secret. Set it, then migrate like the others.
> - `FinnSetchell/MoogsStructureLib` (`wip/forge-port`) — out of scope: it's a library, not a structure mod (no `publish*`/`discord*`/slug keys); the announcement pipeline doesn't apply.
> - `ClientGlowTrims` — out of scope: no `release.yml` at all, multiloader layout; would need a release workflow designed from scratch.
