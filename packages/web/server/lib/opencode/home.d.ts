export declare function engineConfigDir(): string;
export declare function engineDataDir(): string;
export declare function legacyEngineConfigDir(): string;
export declare function legacyEngineDataDir(): string;
export declare function engineHomeEnv(): {
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
  XDG_STATE_HOME: string;
  XDG_CACHE_HOME: string;
};
export declare function migrateEngineHome(options?: {
  fsImpl?: unknown;
  log?: { log?: (message: string) => void; warn?: (...args: unknown[]) => void };
}): { migrated: boolean; reason?: string; copied?: string[] };
