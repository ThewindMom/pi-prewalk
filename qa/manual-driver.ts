import { createHarness } from "../test/harness.ts";

const harness = createHarness();
await harness.start();
await harness.command("fast/executor");
await harness.turn([{ toolName: "read" }, { toolName: "todo" }]);
await harness.turn([{ toolName: "edit" }]);

const executorContext = await harness.filterContext([
  { role: "custom", customType: harness.sent[0].message.customType, content: "hidden planning instruction" },
  { role: "assistant", content: "implementation plan" },
]);

if (harness.currentModel.id !== "executor") throw new Error("executor model was not selected");
if (executorContext.some((message: any) => message.customType?.startsWith("pi-prewalk-plan:"))) {
  throw new Error("planning instruction leaked into executor context");
}

console.log(`armed: ${harness.notifications[0]?.message}`);
console.log(`model: ${harness.currentModel.provider}/${harness.currentModel.id}`);
console.log(`handoff: ${harness.notifications.at(-1)?.message}`);
console.log(`executor context messages: ${executorContext.length}`);
