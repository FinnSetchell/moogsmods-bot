// Low-level Discord plumbing: the authenticated REST helper, interaction-response
// shortcuts, deferred follow-ups, and inbound request signature verification.

import { DISCORD_API } from './config.js';

// Authenticated Discord REST call. Returns parsed JSON (or null for 204).
// Throws on a non-2xx so callers can `.catch(() => {})` fire-and-forget logs.
export async function discordRequest(env, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const resp = await fetch(`${DISCORD_API}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord ${method} ${path} → ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// Type-4 ephemeral interaction response (only the invoking user sees it).
export function ephemeral(content) {
  return Response.json({ type: 4, data: { content, flags: 64 } });
}

// Edit the original deferred interaction response (after a type-5 ACK).
export async function followUp(env, token, content) {
  await fetch(`${DISCORD_API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}

// Verify the Ed25519 signature Discord attaches to every interaction request.
// Reads the body once and returns it so the caller doesn't re-consume the stream.
export async function verifySignature(request, publicKeyHex) {
  const sig  = request.headers.get('X-Signature-Ed25519');
  const ts   = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();
  if (!sig || !ts) return { valid: false, body };

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(sig),
      new TextEncoder().encode(ts + body),
    );
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
