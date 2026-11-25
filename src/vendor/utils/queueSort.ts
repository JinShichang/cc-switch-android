import type { Provider } from "../types";

export function queueMoveSortUpdates(
  items: { providerId: string; sortIndex?: number }[],
  providers: Record<string, Pick<Provider, "sortIndex">>,
  providerId: string,
  delta: -1 | 1,
): { id: string; sortIndex: number }[] | null {
  const index = items.findIndex((item) => item.providerId === providerId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return null;
  const order = items.map((item) => item.providerId);
  order.splice(index, 1);
  order.splice(target, 0, providerId);
  const slots = items
    .map(
      (item, i) => item.sortIndex ?? providers[item.providerId]?.sortIndex ?? i,
    )
    .sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  }
  return order.map((id, i) => ({ id, sortIndex: slots[i] }));
}

