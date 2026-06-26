// Publish-verification alerts. Receives structured results from the verification
// library (release-actions/verify) and turns them into Discord embeds:
//   POST /verify-alert  — one tag, sent by verify.yml at the end of a publish run
//   POST /audit-alert   — many mods/tags, sent by the scheduled audit cron
// This layer is presentation only — the verification logic lives in stdlib Python.
// It renders embeds, picks a severity colour, and routes alpha vs release to the
// right channel. Silent on clean unless the audit requests a heartbeat.

import { AUDIT_SEVERITY, LOG_CHANNEL } from './config.js';
import { discordRequest } from './discord.js';

// Alpha releases route to the alpha-audit channel, everything else to the
// release-audit channel. Both fall back to the mod-log channel if unset, so the
// feature is deployable before dedicated channels exist.
function auditChannel(env, isAlpha) {
  return isAlpha
    ? (env.CHANNEL_AUDIT_ALPHA   || LOG_CHANNEL)
    : (env.CHANNEL_AUDIT_RELEASE || LOG_CHANNEL);
}

function verdictIcon(v) {
  return ({ pass: '✅', pending: '🟡', fail: '❌', error: '⚠️' })[v] || '❔';
}

// Render one verifier result into a per-platform description block with links.
function verifyResultLines(r) {
  const icon = {
    ok: '✅', pass: '✅', incomplete: '🟡', pending: '🟡',
    missing: '❌', wrong_type: '❌', error: '⚠️', skipped: '⚪',
  };
  const mr = r.modrinth || {};
  const cf = r.curseforge || {};

  let mrLine = `${icon[mr.status] || '❔'} **Modrinth:** ${mr.status || 'unknown'}`;
  if (mr.missing_loaders?.length) mrLine += ` — missing ${mr.missing_loaders.join(', ')}`;
  if (mr.missing_mc?.length)      mrLine += ` — missing MC ${mr.missing_mc.join(', ')}`;
  if (mr.error)                   mrLine += ` — ${mr.error}`;
  if (mr.url)                     mrLine += `\n↳ [Modrinth versions](${mr.url})`;

  let cfLine = `${icon[cf.status] || '❔'} **CurseForge:** ${cf.status || 'unknown'}`;
  if (cf.missing?.length) cfLine += ` — missing ${cf.missing.join(', ')}`;
  if (cf.failed?.length)  cfLine += ` — FAILED ${cf.failed.join(', ')}`;
  if (cf.pending?.length) cfLine += ` — pending ${cf.pending.join(', ')}`;
  if (cf.error)           cfLine += ` — ${cf.error}`;
  if (cf.url)             cfLine += `\n↳ [CurseForge files](${cf.url})`;

  return `${mrLine}\n${cfLine}`;
}

// One-tag embed (workflow-time /verify-alert).
function buildVerifyEmbed(p) {
  const label = p.is_alpha ? 'alpha' : 'release';
  const embed = {
    title: `${verdictIcon(p.verdict)} Publish verify — ${p.modName || p.mod} ${p.version}`,
    description: [
      `**Tag:** \`${p.tag || p.version}\`  •  **${label}**`,
      '',
      verifyResultLines(p),
    ].join('\n'),
    color: AUDIT_SEVERITY[p.verdict] ?? AUDIT_SEVERITY.error,
    timestamp: new Date().toISOString(),
  };
  if (p.run_url) embed.url = p.run_url;
  if (p.repo)    embed.footer = { text: p.repo };
  return embed;
}

// POST /verify-alert — a single tag's verification result.
export async function handleVerifyAlert(request, env) {
  const p = await request.json();
  if (!p || !p.mod) return new Response('Bad payload: missing mod', { status: 400 });
  const channel = auditChannel(env, !!p.is_alpha);
  await discordRequest(env, 'POST', `/channels/${channel}/messages`, {
    embeds: [buildVerifyEmbed(p)],
  });
  return new Response('ok', { status: 200 });
}

// POST /audit-alert — a batch of results from the scheduled audit.
export async function handleAuditAlert(request, env) {
  const p = await request.json();
  const results   = Array.isArray(p.results) ? p.results : [];
  const heartbeat = !!p.heartbeat;

  let posted = 0;
  // Route alpha vs release into their own channels; build each independently.
  for (const isAlpha of [false, true]) {
    const group   = results.filter(r => !!r.is_alpha === isAlpha);
    const failing = group.filter(r => r.verdict === 'fail' || r.verdict === 'error');
    if (!failing.length && !heartbeat) continue;

    const channel = auditChannel(env, isAlpha);
    const label   = isAlpha ? 'Alpha' : 'Release';
    const lead = {
      title: failing.length
        ? `❌ ${label} audit — ${failing.length} issue${failing.length === 1 ? '' : 's'}`
        : `✅ ${label} audit — all clear`,
      description: `Checked **${group.length}** ${label.toLowerCase()} release${group.length === 1 ? '' : 's'} across the registry.`,
      color: failing.length ? AUDIT_SEVERITY.fail : AUDIT_SEVERITY.pass,
      timestamp: new Date().toISOString(),
    };
    if (p.run_url) lead.url = p.run_url;

    const detail = failing.map(r => ({
      title: `${verdictIcon(r.verdict)} ${r.modName || r.mod} ${r.version}`,
      description: [`**Tag:** \`${r.tag || r.version}\``, '', verifyResultLines(r)].join('\n'),
      color: AUDIT_SEVERITY[r.verdict] ?? AUDIT_SEVERITY.error,
    }));

    // Discord caps a message at 10 embeds — lead first, then chunk the details.
    const embeds = [lead, ...detail];
    for (let i = 0; i < embeds.length; i += 10) {
      await discordRequest(env, 'POST', `/channels/${channel}/messages`, {
        embeds: embeds.slice(i, i + 10),
      });
      posted++;
    }
  }
  return new Response(`ok (${posted} message${posted === 1 ? '' : 's'})`, { status: 200 });
}
