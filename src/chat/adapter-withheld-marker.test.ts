import { expect, test } from "bun:test";
import { ConversationProjection } from "./adapter";
import { ConversationReplay } from "./replay";
import type { BackgroundTaskItem } from "./types";

for (const explicitFalse of [false, true])
test(`authoritative terminal publication discharges a withheld marker by omission, not false (${explicitFalse})`, () => {
  const projection = new ConversationProjection(new ConversationReplay("g", "c", 100_000));
  const row: BackgroundTaskItem = { id: "task:fixture", type: "background_task", taskId: "fixture", taskType: "agent",
    createdAt: 10, description: "Fixture", status: "running", stateUncertain: true, outcomeWithheld: true };
  projection.apply({ kind: "upsert", item: row });
  const { outcomeWithheld: _, ...sparse } = row;
  projection.apply({ kind: "upsert", item: sparse });
  expect(projection.get(row.id)).toHaveProperty("outcomeWithheld", true);
  projection.apply({ kind: "upsert", item: { ...sparse, outcomeWithheld: false } });
  expect(projection.get(row.id)).toHaveProperty("outcomeWithheld", true);
  const authoritative = { ...sparse, status: "completed" as const, stateUncertain: false, resultId: "native-result", summary: "Done" };
  const incoming = { ...authoritative, ...(explicitFalse ? { outcomeWithheld: false } : {}) };
  const event = projection.apply({ kind: "upsert", item: incoming });
  expect(event).toMatchObject({ type: "item.upsert", item: authoritative });
  expect(projection.get(row.id)).not.toHaveProperty("outcomeWithheld");
  if (event?.type === "item.upsert") expect(event.item).not.toHaveProperty("outcomeWithheld");
  expect(row.outcomeWithheld).toBe(true); // Earlier publications are immutable.
});
