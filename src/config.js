// Shared constants that are NOT environment-specific.
// Channel/role IDs that vary per deployment live in wrangler.toml [vars] and are
// read off `env`; the values here are fixed API bases and a couple of pinned
// channel IDs that have never needed to change.

export const DISCORD_API = 'https://discord.com/api/v10';
export const GITHUB_API  = 'https://api.github.com';
export const WORKER_URL  = 'https://moogsmods-bot.finndog176.workers.dev';

// Moderation log — every mod action is mirrored here.
export const LOG_CHANNEL  = '1131312070755893268';
// Staff guide channel — holds the single pinned sendDocs() embed.
export const DOCS_CHANNEL = '1118598313709682769';

// Severity → embed colour for publish-verification alerts.
export const AUDIT_SEVERITY = {
  pass:    0x57F287, // green
  pending: 0xFEE75C, // yellow
  fail:    0xED4245, // red
  error:   0xE67E22, // orange
};
