// Discord interaction entry (POST /interactions): verify the signature, gate to
// the owner, then dispatch by interaction type to the command / button / modal
// handlers in this folder.

import { ephemeral, verifySignature } from '../discord.js';
import { handleCommand } from './commands.js';
import { handleButton } from './buttons.js';
import { handleModal } from './modals.js';

export async function handleInteraction(request, env, ctx) {
  const { valid, body } = await verifySignature(request, env.DISCORD_PUBLIC_KEY);
  if (!valid) return new Response('Unauthorized', { status: 401 });

  const interaction = JSON.parse(body);

  if (interaction.type === 1) return Response.json({ type: 1 }); // PING

  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (userId !== env.FINN_USER_ID) {
    return ephemeral('Not permitted.');
  }

  if (interaction.type === 2) return handleCommand(interaction, env);   // command / context menu
  if (interaction.type === 3) return handleButton(interaction, env);    // message component
  if (interaction.type === 5) return handleModal(interaction, env, ctx); // modal submit

  return new Response('Unknown interaction type', { status: 400 });
}
