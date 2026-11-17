import { afterEach, expect, it, vi } from 'vitest';
import { configuredRemoteConfig, defaultRemoteConfig } from '../src/remote-config.js';
import { buildServer } from '../src/server.js';
afterEach(() => vi.unstubAllEnvs());
it('serves default public settings while preserving security headers and CORS', async () => {
  vi.stubEnv('REMOTE_CONFIG_JSON', '');
  const server = await buildServer();
  try {
    const response = await server.inject({ method: 'GET', url: '/v1/mobile-config', headers: { origin: 'https://untrusted.example' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(defaultRemoteConfig);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  } finally { await server.close(); }
});
it('accepts bilingual notices and presentation settings from the environment', async () => {
  const config = { ...defaultRemoteConfig, revision: 'notice-1', notices: [{ id: 'welcome', title: { en: 'Welcome', my: 'မင်္ဂလာပါ' }, body: { en: 'Hello', my: 'မင်္ဂလာပါ' } }], features: { ...defaultRemoteConfig.features, carouselAutoplay: false } };
  vi.stubEnv('REMOTE_CONFIG_JSON', JSON.stringify(config));
  const server = await buildServer();
  try { expect((await server.inject('/v1/mobile-config')).json()).toEqual(config); } finally { await server.close(); }
});
it('rejects malformed, oversized, unknown, duplicate, and out-of-range settings', () => {
  const notice = { id: 'same', title: { en: 'Hi', my: 'Hi' }, body: { en: 'Hi', my: 'Hi' } };
  for (const raw of ['{', ' '.repeat(32769), JSON.stringify({ ...defaultRemoteConfig, schemaVersion: 2 }), JSON.stringify({ ...defaultRemoteConfig, admob: false }), JSON.stringify({ ...defaultRemoteConfig, notices: [notice, notice] }), JSON.stringify({ ...defaultRemoteConfig, features: { ...defaultRemoteConfig.features, carouselIntervalMs: 1 } })]) {
    expect(configuredRemoteConfig(raw)).toEqual(defaultRemoteConfig);
  }
});
it('accepts new optional semantic theme colors while preserving legacy config', () => {
  const config = { ...defaultRemoteConfig, theme: { light: { background: '#F4F8FF', primary: '#1264D8', onPrimary: '#FFFFFF', accent: '#FFCA28', onAccent: '#102445', resultBackground: '#1264D8' }, dark: { background: '#0B1425', primary: '#8DBBFF' } } };
  expect(configuredRemoteConfig(JSON.stringify(config))).toEqual(config);
  expect(configuredRemoteConfig(JSON.stringify({ ...config, theme: { light: { permissions: '#FFFFFF' }, dark: {} } }))).toEqual(defaultRemoteConfig);
});
