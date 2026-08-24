export interface Config {
  devMode: boolean; // SHIPWAY_DEV === '1'
  port: number; // SHIPWAY_PORT ?? 8090
  dataDir: string; // SHIPWAY_DATA_DIR ?? (devMode ? './data' : '/var/lib/shipway')
  appsDir: string; // SHIPWAY_APPS_DIR ?? (devMode ? './data/apps' : '/var/deploy/apps')
  logsDir: string; // SHIPWAY_LOGS_DIR ?? (devMode ? './data/logs' : '/var/deploy/logs')
  dbPath: string; // `${dataDir}/shipway.db`
  secretKeyPath: string; // `${dataDir}/secret.key`
  sessionKeyPath: string; // `${dataDir}/session.key`
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devMode = env.SHIPWAY_DEV === '1';
  const port = env.SHIPWAY_PORT ? Number(env.SHIPWAY_PORT) : 8090;
  const dataDir = env.SHIPWAY_DATA_DIR ?? (devMode ? './data' : '/var/lib/shipway');
  const appsDir = env.SHIPWAY_APPS_DIR ?? (devMode ? './data/apps' : '/var/deploy/apps');
  const logsDir = env.SHIPWAY_LOGS_DIR ?? (devMode ? './data/logs' : '/var/deploy/logs');

  return {
    devMode,
    port,
    dataDir,
    appsDir,
    logsDir,
    dbPath: `${dataDir}/shipway.db`,
    secretKeyPath: `${dataDir}/secret.key`,
    sessionKeyPath: `${dataDir}/session.key`,
  };
}
