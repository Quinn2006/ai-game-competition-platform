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

test('production separates HTTPS public origins from a loopback game listener without LOCAL_GAMES', () => {
  const env = {APP_ENV:'production',MAIN_ORIGIN:'https://main.example.com',GAME_ORIGIN:'https://game.example.net',
    DATABASE_URL:'postgres://app_production:synthetic@localhost/ai_games_production',SESSION_SECRET:'x'.repeat(32),
    PRIVATE_STORAGE_DRIVER:'local',PRIVATE_STORAGE_ROOT:'tmp/production-config',PRIVATE_STORAGE_ACCOUNT:'synthetic-service'};
  const config = loadConfig(env);
  assert.equal(config.localGames,false);
  assert.equal(config.gameListenOrigin,'http://127.0.0.2:4321');
  assert.throws(()=>loadConfig({...env,LOCAL_GAMES:'1'}),/LOCAL_GAMES/);
  for(const value of ['http://0.0.0.0:4321','http://example.com:4321','https://127.0.0.2:4321','http://127.0.0.2']) {
    assert.throws(()=>loadConfig({...env,GAME_LISTEN_ORIGIN:value}),/GAME_LISTEN_ORIGIN/);
  }
  assert.equal(loadConfig({...env,GAME_LISTEN_ORIGIN:'http://127.0.0.3:4322'}).gameListenOrigin,'http://127.0.0.3:4322');
});
