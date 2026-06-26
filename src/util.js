// Pure helpers — no environment, no network. Safe to use anywhere.

// "#c20045" -> 0xc20045 (Discord embed colour integer).
export function hexColor(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// Render a Minecraft version range for display, e.g. "1.21 - 1.21.11, 26.1, 26.2".
export function versionRange(start, end, extra = []) {
  const base = start === end ? start : `${start} - ${end}`;
  return extra.length > 0 ? `${base}, ${extra.join(', ')}` : base;
}

// Embed footer helpers (used to stamp review cards with their current status).
export function withFooter(embed, text) {
  return { ...embed, footer: { text } };
}

export function withoutFooter(embed) {
  const { footer, ...rest } = embed;
  return rest;
}

// Parse a human duration ("30s", "5m", "24h", "7d", "none"/"0") into seconds.
// Returns 0 for none/0, null if the string is invalid.
export function parseDuration(str) {
  const s = (str ?? '').trim().toLowerCase();
  if (s === 'none' || s === '0') return 0;
  const match = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d|w)$/);
  if (!match) return null;
  const n    = parseFloat(match[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.round(n * mult[match[2]]);
}

// Inverse of parseDuration for display — picks the largest sensible unit.
export function formatDuration(seconds) {
  if (seconds >= 604800) return `${Math.round(seconds / 604800)}w`;
  if (seconds >= 86400)  return `${Math.round(seconds / 86400)}d`;
  if (seconds >= 3600)   return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60)     return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

// Release type -> human label for the destination channel (display only).
export function channelLabel(type) {
  if (type === 'minor') return '#minor-builds';
  if (type === 'alpha') return '#test-builds';
  if (type === 'major_everyone') return '#announcements (@everyone)';
  return '#announcements';
}

// Release type -> human label (collapses the @everyone variant).
export function releaseTypeLabel(type) {
  if (type === 'major_everyone') return 'major (@everyone)';
  return type;
}
