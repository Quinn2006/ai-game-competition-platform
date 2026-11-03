import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../backend/src/config.mjs';

test('public game URL uses a separate loopback listener', () => {
  const env = { LOCAL_GAMES:'1', MAIN_ORIGIN:'https://main.example.com', GAME_ORIGIN:'https://game.example.net', GAME_LISTEN_ORIGIN:'http://127.0.0.2:4321' };
  const config = loadConfig(env);
  assert.equal(config.gameListenOrigin, env.GAME_LISTEN_ORIGIN);
  assert.equal(config.gameOrigin, env.GAME_ORIGIN);
  assert.throws(() => loadConfig({...env,GAME_LISTEN_ORIGIN:'http://0.0.0.0:4321'}), /LOCAL_GAMES/);
  assert.throws(() => loadConfig({...env,GAME_LISTEN_ORIGIN:'https://127.0.0.2:4321'}), /LOCAL_GAMES/);
  assert.equal(loadConfig({LOCAL_GAMES:'1'}).gameListenOrigin,'http://127.0.0.2:4321');
});
