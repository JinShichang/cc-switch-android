import template from "../upstream/codex_native_responses_template.json" with { type: "json" };
import official from "../upstream/gpt5_5_template.json" with { type: "json" };
import type { Provider } from "./types.ts";
export function modelCatalog(
  provider: Provider,
): { name: string; text: string } | null {
  const catalog = provider.settingsConfig.modelCatalog;
  if (!catalog?.models?.length) return null;
  const allowed = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];
  const models = catalog.models.map((m, index) => {
    const base: any = structuredClone(
      m.model === "gpt-5.5" ? official : template,
    );
    const context = m.contextWindow
      ? Number(m.contextWindow)
      : base.context_window;
    if (!m.model.trim() || !Number.isSafeInteger(context) || context < 1)
      throw Error("模型目录的名称和上下文窗口无效");
    const entry: any = {
      ...base,
      slug: m.model.trim(),
      display_name: m.displayName?.trim() || m.model.trim(),
      description: m.displayName?.trim() || m.model.trim(),
      context_window: context,
      max_context_window: context,
      visibility: "list",
      priority: 1000 + index,
      availability_nux: null,
      upgrade: null,
    };
    if (!catalog.officialSpeedTiers) {
      entry.additional_speed_tiers = [];
      entry.service_tiers = [];
    }
    if (m.supportsParallelToolCalls !== undefined)
      entry.supports_parallel_tool_calls = m.supportsParallelToolCalls;
    if (m.inputModalities?.length) entry.input_modalities = m.inputModalities;
    if (m.baseInstructions) entry.base_instructions = m.baseInstructions;
    if (m.reasoningLevels?.length) {
      if (m.reasoningLevels.some((l) => !allowed.includes(l)))
        throw Error("模型推理等级无效");
      entry.supported_reasoning_levels = m.reasoningLevels.map((e) => ({
        effort: e,
        description: e,
      }));
      entry.default_reasoning_level =
        m.defaultReasoningLevel &&
        m.reasoningLevels.includes(m.defaultReasoningLevel)
          ? m.defaultReasoningLevel
          : m.reasoningLevels.includes(base.default_reasoning_level)
            ? base.default_reasoning_level
            : m.reasoningLevels[0];
    }
    if (
      catalog.autoReviewModel &&
      catalog.models.some((v) => v.model === catalog.autoReviewModel)
    )
      entry.auto_review_model_override = catalog.autoReviewModel;
    return entry;
  });
  const text = JSON.stringify({ models }, null, 2) + "\n";
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(text))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return {
    name: "cc-switch-model-catalog-" + hash.toString(16) + ".json",
    text,
  };
}
