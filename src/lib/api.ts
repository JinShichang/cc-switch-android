export type AppId = "codex";
export interface Prompt {
  id: string;
  name: string;
  content: string;
  description?: string;
  updatedAt: number;
  enabled?: boolean;
}
