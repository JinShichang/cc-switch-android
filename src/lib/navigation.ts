export type GlobalPage =
  | "mcp"
  | "skills"
  | "prompts"
  | "sessions"
  | "auth"
  | "usage"
  | "apps";
export type View = "providers" | GlobalPage | "settings";
export type SettingsSection = "general" | "appConfig" | "data" | "about";
export const isAppPage = (view: View) => view === "providers";
