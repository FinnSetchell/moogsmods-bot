// Worker entry point: the cron handler and the HTTP router. All real logic lives
// in the imported modules — this file just verifies auth and dispatches.
//
//   config.js        non-env constants            discord.js     Discord REST + signatures
//   util.js          pure helpers                 components.js  embed/button/modal builders
//   releases.js      release flow + /release,/published + cron processor
//   interactions.js  Discord command/button/modal dispatch (POST /interactions)
//   moderation.js    timeout / purge / lock       audit.js       /verify-alert, /audit-alert
//   registration.js  command registration         docs.js        staff-guide embed
//   interactions/    command + button + modal handlers (index dispatches)

import { handleRelease, handlePublished, processScheduledReleases } from './releases.js';
import { handleInteraction } from './interactions/index.js';
import { handleVerifyAlert, handleAuditAlert } from './audit.js';
import { registerCommands } from './registration.js';
import { sendDocs } from './docs.js';

// Endpoints guarded by the shared X-API-Key (everything except Discord's own
// signature-verified /interactions and the public GET /).
function unauthorized(request, env) {
  return request.headers.get('X-API-Key') !== env.WORKER_API_KEY;
}

export default {
  // Runs every 30 min (wrangler.toml cron) to fire any due scheduled releases.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledReleases(env));
  },

  async fetch(request, env, ctx) {
    const { method } = request;
    const { pathname } = new URL(request.url);

    if (method === 'GET' && pathname === '/') {
      return new Response("Moog's Mods Bot is running", { status: 200 });
    }
    if (method === 'POST' && pathname === '/register-commands') {
      if (unauthorized(request, env)) return new Response('Unauthorized', { status: 401 });
      return registerCommands(env);
    }
    if (method === 'POST' && pathname === '/send-docs') {
      if (unauthorized(request, env)) return new Response('Unauthorized', { status: 401 });
      return sendDocs(env).then(id => new Response(`Docs posted. Message ID: ${id}`, { status: 200 }))
        .catch(err => new Response(`Failed: ${err.message}`, { status: 500 }));
    }
    // /release and /published check the API key inside their handlers.
    if (method === 'POST' && pathname === '/release') {
      return handleRelease(request, env).catch(err => {
        console.error('Release handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/published') {
      return handlePublished(request, env).catch(err => {
        console.error('Published handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/verify-alert') {
      if (unauthorized(request, env)) return new Response('Unauthorized', { status: 401 });
      return handleVerifyAlert(request, env).catch(err => {
        console.error('Verify-alert handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/audit-alert') {
      if (unauthorized(request, env)) return new Response('Unauthorized', { status: 401 });
      return handleAuditAlert(request, env).catch(err => {
        console.error('Audit-alert handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    if (method === 'POST' && pathname === '/interactions') {
      return handleInteraction(request, env, ctx).catch(err => {
        console.error('Interaction handler error:', err);
        return new Response(err.message, { status: 500 });
      });
    }
    return new Response('Not found', { status: 404 });
  },
};
