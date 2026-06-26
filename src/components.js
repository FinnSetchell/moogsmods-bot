// Builders for Discord message components (button rows, modal text inputs) and
// the release "preview card" embeds. Pure functions of their inputs.

import { hexColor, versionRange, channelLabel, releaseTypeLabel } from './util.js';

// ── Preview card ─────────────────────────────────────────────────────────────

// The review-card embeds: a main card (title, changelog excerpt, status footer)
// plus extra image embeds for any screenshots. Returns an array of embeds.
export function buildPreviewEmbeds(release) {
  const color       = hexColor(release.color || '#c20045');
  const versionsStr = versionRange(release.mcStart, release.mcEnd, release.mcExtra ?? []);
  const isAlpha     = release.releaseType === 'alpha';
  const typeIcon    = isAlpha ? '🧪' : release.releaseType === 'major_everyone' ? '📢' : '🎉';
  const imageUrls   = (release.imageUrls ?? []).slice(0, 4);
  const gridUrl     = `https://www.curseforge.com/minecraft/mc-mods/${release.cfSlug ?? 'mns-moogs-nether-structures'}`;

  const main = {
    title: `[PREVIEW] ${release.modName} ${release.version}`,
    description: [
      `${typeIcon} **${release.modName} ${release.version}** — ${versionsStr}`,
      '',
      (release.changelog ?? '').slice(0, 800),
    ].join('\n'),
    color,
    thumbnail: { url: release.thumbnailUrl },
    footer: { text: `→ ${channelLabel(release.releaseType)} | ${release.project ?? ''} | ${releaseTypeLabel(release.releaseType)}` },
  };

  if (imageUrls.length > 0) {
    main.url = gridUrl;
    main.image = { url: imageUrls[0] };
  }

  return [
    main,
    ...imageUrls.slice(1).map(u => ({ url: gridUrl, image: { url: u }, color })),
  ];
}

// Just the main preview embed (used when re-stamping a card with a new footer).
export function buildPreviewEmbed(release) {
  return buildPreviewEmbeds(release)[0];
}

// ── Button rows ──────────────────────────────────────────────────────────────

// Initial review-card actions.
export function approveRejectGroupRow(releaseId) {
  return {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve',  custom_id: `approve:${releaseId}`,  emoji: { name: '✅' } },
      { type: 2, style: 4, label: 'Reject',   custom_id: `reject:${releaseId}`,   emoji: { id: '1115379522754322583', name: 'no' } },
      { type: 2, style: 2, label: 'Group',    custom_id: `group:${releaseId}`,    emoji: { name: '🔗' } },
      { type: 2, style: 2, label: 'Schedule', custom_id: `schedule:${releaseId}`, emoji: { name: '⏰' } },
    ],
  };
}

// Shown after a publish failure.
export function retryRejectRow(releaseId) {
  return {
    type: 1,
    components: [
      { type: 2, style: 1, label: '🔄 Retry Publish', custom_id: `retry:${releaseId}` },
      { type: 2, style: 4, label: 'Reject', custom_id: `reject:${releaseId}`, emoji: { id: '1115379522754322583', name: 'no' } },
    ],
  };
}

// Shown on a card once it has been grouped.
export function ungroupRow(releaseId) {
  return {
    type: 1,
    components: [
      { type: 2, style: 2, label: '🔗 Grouped ✓', custom_id: `noop:${releaseId}`, disabled: true },
      { type: 2, style: 4, label: 'Ungroup',       custom_id: `ungroup:${releaseId}` },
    ],
  };
}

// ── Modal inputs ─────────────────────────────────────────────────────────────

// A single-input action row for a modal. style 1 = short, 2 = paragraph.
export function textInputRow(customId, label, value, style = 1, required = true) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: customId,
      label,
      style,
      value: value || undefined,
      required,
    }],
  };
}
