import { describe, expect, it } from "vitest";
import { transitionHistoryGroup } from "./historyGroup";

describe("history grouping", () => {
  it("records only the first update from one pointer drag", () => {
    const first = transitionHistoryGroup(null, "timeline-drag-1");
    const move = transitionHistoryGroup(first.activeGroup, "timeline-drag-1");
    const laterMove = transitionHistoryGroup(move.activeGroup, "timeline-drag-1");

    expect(first.shouldRecord).toBe(true);
    expect(move.shouldRecord).toBe(false);
    expect(laterMove.shouldRecord).toBe(false);
  });

  it("records a new drag and every ordinary edit", () => {
    expect(transitionHistoryGroup("timeline-drag-1", "timeline-drag-2").shouldRecord).toBe(true);
    expect(transitionHistoryGroup("timeline-drag-1").shouldRecord).toBe(true);
  });
});
