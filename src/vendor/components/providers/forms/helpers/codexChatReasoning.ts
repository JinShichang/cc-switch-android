import type { CodexChatEffortParam } from "@/vendor/types";

export const normalizeEnabledCodexChatEffortParam = (
  effortParam?: string,
): CodexChatEffortParam =>
  effortParam === "reasoning.effort" ? "reasoning.effort" : "reasoning_effort";
