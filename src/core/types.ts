export type AuthKind = "apiKey" | "official" | "env" | "none";
export type LoginPolicy = "auto" | "keep" | "omit";
export type TomlObject = Record<string, any>;

/** Same settingsConfig shape as upstream CC Switch's Codex Provider. */
export interface Provider {
  id: string;
  name: string;
  settingsConfig: { auth: Record<string, unknown>; config: string };
  category: "custom" | "official";
  authKind: AuthKind;
  loginPolicy: LoginPolicy;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Ownership {
  written: TomlObject;
  prior: TomlObject;
}

export interface DirectoryInfo {
  uri: string;
  name: string;
  authority: string;
  providerPackage: string;
  isCodexProvider: boolean;
  canWrite: boolean;
}

export interface Snapshot {
  config: string | null;
  auth: string | null;
  revision: string;
  directory: DirectoryInfo;
  ownership?: Ownership;
}

export interface Backup {
  id: string;
  createdAt: number;
  reason: string;
  directoryName: string;
  treeUri: string;
  existed: boolean;
}

export interface AppState {
  providers: Provider[];
  backups: Backup[];
  directory: DirectoryInfo | null;
  pendingRecovery: boolean;
  lastApplied?: { id: string; time: number; revision: string; treeUri: string };
  settings: { zoom: number; theme: "light" | "dark" | "system" };
  native: boolean;
}

export interface ApplyPlan {
  config: string;
  ownership: Ownership;
  changedFields: string[];
  warnings: string[];
}

export class ConfigError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}
