export type AuthKind = "apiKey" | "official" | "env" | "none";
export type LoginPolicy = "auto" | "keep" | "omit";
export type TomlObject = Record<string, any>;

/** Same settingsConfig shape as upstream CC Switch's Codex Provider. */
export interface Provider {
  id: string;
  name: string;
  settingsConfig: {
    auth: Record<string, unknown>;
    config: string;
    modelCatalog?: {
      models: import("../vendor/types").CodexCatalogModel[];
      autoReviewModel?: string;
      officialSpeedTiers?: boolean;
    };
  };
  meta?: Record<string, any>;
  websiteUrl?: string;
  icon?: string;
  iconColor?: string;
  historyFilter?: boolean;
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
  filteredRoutes?: Record<
    string,
    {
      url: string;
      baseUrl?: string;
      isFullUrl?: boolean;
      providerId: string;
      apiKey: string;
      sourceHeaders?: Record<string, string>;
      sourceQueryParams?: Record<string, string>;
      sourceWebsockets?: boolean;
    }
  >;
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
  prompts?: import("../lib/api").Prompt[];
  documentBackups?: {
    id: string;
    createdAt: number;
    path: string;
    treeUri: string;
    reason: string;
  }[];
  pendingDocuments?: string[];
}

export interface ApplyPlan {
  catalog?: { name: string; text: string };
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
