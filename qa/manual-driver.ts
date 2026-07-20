import { createHarness } from "../test/harness.ts";

const harness = createHarness({
  config: {
    enabled: true,
    roles: {
      planner: "frontier/architect",
      smol: "fast/executor",
    },
    planner: { model: "role:planner", thinking: "medium" },
    executor: { model: "role:smol", thinking: "low" },
  },
});
await harness.start();
await harness.command("status");
if (!harness.notifications.at(-1)?.message.includes("role:smol -> fast/executor")) {
  throw new Error("status did not report the configured role and resolved executor");
}
await harness.turn([{ toolName: "read" }, { toolName: "todo" }]);
await harness.turn([{ toolName: "edit" }]);

const executorContext = await harness.filterContext([
  { role: "custom", customType: harness.sent[0].message.customType, content: "hidden planning instruction" },
  { role: "assistant", content: "implementation plan" },
]);

if (harness.currentModel.id !== "executor") throw new Error("executor model was not selected");
if (harness.thinkingChanges.join(",") !== "medium,low") {
  throw new Error(`unexpected thinking levels: ${harness.thinkingChanges.join(",")}`);
}
if (executorContext.some((message: any) => message.customType?.startsWith("pi-prewalk-plan:"))) {
  throw new Error("planning instruction leaked into executor context");
}

console.log(`armed: ${harness.notifications[0]?.message}`);
console.log(`model: ${harness.currentModel.provider}/${harness.currentModel.id}`);
console.log(`thinking: ${harness.thinkingChanges.join(" → ")}`);
console.log(`handoff: ${harness.notifications.at(-1)?.message}`);
console.log(`executor context messages: ${executorContext.length}`);
