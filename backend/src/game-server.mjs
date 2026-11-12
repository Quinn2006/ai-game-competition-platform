import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRuntimeConfig } from './platform/isolated-runtime.mjs';
import { callChannel, serveChannel } from './platform/service-channel.mjs';
import { readBound, isId } from './platform/serving-store.mjs';
import { createGameListener } from './modules/uploads/game-listener.mjs';

export async function startGameServer(config) {
  const listen = new URL(config.gameListenOrigin);
  if (!['127.0.0.2', '127.0.0.3'].includes(listen.hostname) || listen.protocol !== 'http:') throw Error('Invalid game listener');
  const game = createGameListener({ config,
    authorize: (token, path) => callChannel(config.auth, { action: 'authorize', token, path }),
    readAsset: async permit => {
      if (!isId(permit.id) || !permit.entry) throw Error('Invalid asset permit');
      return readBound(join(config.servingRoot, permit.id), permit.entry.digest, permit.entry.digest, permit.entry.size);
    },
  });
  let control;
  try {
    await new Promise((resolve, reject) => { game.once('error', reject); game.listen(Number(listen.port), listen.hostname, () => { game.off('error', reject); resolve(); }); });
    control = await serveChannel(config.control, async input => {
      if (input?.action !== 'health') throw Error('Invalid action');
      return { ready: game.listening, pid: process.pid, address: game.address() };
    });
    return { game, async stop() { await control.close(); await new Promise(resolve => { game.close(resolve); game.closeAllConnections(); }); } };
  } catch (error) { await control?.close(); game.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startGameServer(await readRuntimeConfig(process.argv[2], 'game'));
    for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => runtime.stop());
  } catch { console.error('Game startup failed'); process.exitCode = 1; }
}
