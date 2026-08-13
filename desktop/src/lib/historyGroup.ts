export type HistoryUpdateOptions = {
  historyGroup?: string;
};

export function transitionHistoryGroup(activeGroup: string | null, requestedGroup?: string) {
  const nextGroup = String(requestedGroup ?? "").trim() || null;
  return {
    activeGroup: nextGroup,
    shouldRecord: nextGroup === null || nextGroup !== activeGroup,
  };
}
