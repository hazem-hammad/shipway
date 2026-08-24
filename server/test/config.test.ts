import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('dev mode: devMode true, default port, data/apps/logs dirs under ./data', () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1' });
    expect(cfg.devMode).toBe(true);
    expect(cfg.port).toBe(8090);
    expect(cfg.dataDir).toBe('./data');
    expect(cfg.appsDir).toBe('./data/apps');
    expect(cfg.logsDir).toBe('./data/logs');
  });

  it('production mode (no SHIPWAY_DEV): default port, /var paths', () => {
    const cfg = loadConfig({ SHIPWAY_PORT: '9000' });
    expect(cfg.devMode).toBe(false);
    expect(cfg.port).toBe(9000);
    expect(cfg.dataDir).toBe('/var/lib/shipway');
    expect(cfg.appsDir).toBe('/var/deploy/apps');
    expect(cfg.logsDir).toBe('/var/deploy/logs');
  });

  it('production mode without SHIPWAY_PORT defaults to 8090', () => {
    const cfg = loadConfig({});
    expect(cfg.devMode).toBe(false);
    expect(cfg.port).toBe(8090);
  });

  it('derives dbPath/secretKeyPath/sessionKeyPath from dataDir', () => {
    const cfg = loadConfig({ SHIPWAY_DEV: '1' });
    expect(cfg.dbPath).toBe('./data/shipway.db');
    expect(cfg.secretKeyPath).toBe('./data/secret.key');
    expect(cfg.sessionKeyPath).toBe('./data/session.key');
  });

  it('respects explicit overrides for dataDir/appsDir/logsDir', () => {
    const cfg = loadConfig({
      SHIPWAY_DATA_DIR: '/tmp/custom-data',
      SHIPWAY_APPS_DIR: '/tmp/custom-apps',
      SHIPWAY_LOGS_DIR: '/tmp/custom-logs',
    });
    expect(cfg.dataDir).toBe('/tmp/custom-data');
    expect(cfg.appsDir).toBe('/tmp/custom-apps');
    expect(cfg.logsDir).toBe('/tmp/custom-logs');
    expect(cfg.dbPath).toBe('/tmp/custom-data/shipway.db');
    expect(cfg.secretKeyPath).toBe('/tmp/custom-data/secret.key');
    expect(cfg.sessionKeyPath).toBe('/tmp/custom-data/session.key');
  });

  it('defaults to process.env when no env argument is given', () => {
    const cfg = loadConfig();
    expect(typeof cfg.devMode).toBe('boolean');
    expect(typeof cfg.port).toBe('number');
  });
});
