import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PREWALK_CHECKLIST_PROMPT, PREWALK_CONTINUE_PROMPT, PREWALK_PLAN_PROMPT } from "./prompts.ts";

const ENTRY_TYPE = "pi-prewalk-state";
const STATUS_KEY = "pi-prewalk";
const PLAN_MESSAGE_PREFIX = "pi-prewalk-plan";
const CONTINUE_MESSAGE_TYPE = "pi-prewalk-continue";
const CHECKLIST_MESSAGE_TYPE = "pi-prewalk-checklist";
const ACTION_TOOLS = new Set(["edit", "write"]);
const APPLY_PATCH_COMMAND = /(?:^|(?:&&|\|\||\||;|\n)\s*)(?:[^\s;&|]*\/)?apply_patch(?=\s*(?:$|&&|\|\||;|\n|<<))/m;

function shellStructure(command: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  let result = "";

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (comment) {
      if (character === "\n") {
        comment = false;
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      result += " ";
      continue;
    }

    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === "\\") escaped = true;
      result += " ";
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      result += " ";
    } else if (character === "\\") {
      escaped = true;
      result += " ";
    } else if (character === "#" && (index === 0 || /[\s;&|]/.test(command[index - 1] ?? ""))) {
      comment = true;
      result += " ";
    } else {
      result += character;
    }
  }

  return result;
}

function isApplyPatchCall(message: unknown, toolCallId: string): boolean {
  if (!message || typeof message !== "object" || !("content" in message)) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;

  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const toolCall = part as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (toolCall.type !== "toolCall" || toolCall.id !== toolCallId || toolCall.name !== "bash") return false;
    if (!toolCall.arguments || typeof toolCall.arguments !== "object") return false;
    const command = (toolCall.arguments as { command?: unknown }).command;
    return typeof command === "string" && APPLY_PATCH_COMMAND.test(shellStructure(command));
  });
}

export type PrewalkPhase = "idle" | "armed" | "switched";

export interface PrewalkTarget {
  provider: string;
  id: string;
}

export interface PrewalkState {
  version: 1;
  phase: PrewalkPhase;
  target?: PrewalkTarget;
  planMessageType?: string;
  planInjected: boolean;
  continuePending: boolean;
  todoSeen: boolean;
  scrubPlan: boolean;
}

export const initialState = (): PrewalkState => ({
  version: 1,
  phase: "idle",
  planInjected: false,
  continuePending: false,
  todoSeen: false,
  scrubPlan: false,
});

function isState(value: unknown): value is PrewalkState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PrewalkState>;
  return (
    candidate.version === 1 &&
    (candidate.phase === "idle" || candidate.phase === "armed" || candidate.phase === "switched") &&
    typeof candidate.planInjected === "boolean" &&
    typeof candidate.continuePending === "boolean" &&
    typeof candidate.todoSeen === "boolean" &&
    typeof candidate.scrubPlan === "boolean"
  );
}

function targetLabel(target: PrewalkTarget | undefined): string {
  return target ? `${target.provider}/${target.id}` : "unconfigured";
}

export function resolveTarget(spec: string, models: Model<any>[]): { model?: Model<any>; error?: string } {
  const query = spec.trim();
  if (!query) return { error: "No executor model configured." };

  const slash = query.indexOf("/");
  if (slash > 0) {
    const provider = query.slice(0, slash);
    const id = query.slice(slash + 1);
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
    return model ? { model } : { error: `Model \"${query}\" is not available.` };
  }

  const matches = models.filter((candidate) => candidate.id === query);
  if (matches.length === 1) return { model: matches[0] };
  if (matches.length > 1) {
    return { error: `Model id \"${query}\" is ambiguous; use provider/model.` };
  }
  return { error: `Model \"${query}\" is not available.` };
}

function configuredTarget(pi: ExtensionAPI): string {
  const flag = pi.getFlag("prewalk-into");
  if (typeof flag === "string" && flag.trim()) return flag.trim();
  return process.env.PI_PREWALK_MODEL?.trim() ?? "";
}

export default function prewalkExtension(pi: ExtensionAPI): void {
  let state = initialState();

  pi.registerFlag("prewalk", {
    description: "Start with Prewalk enabled",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("prewalk-into", {
    description: "Executor model for Prewalk (provider/model)",
    type: "string",
    default: "",
  });

  function persist(): void {
    pi.appendEntry(ENTRY_TYPE, { ...state, target: state.target ? { ...state.target } : undefined });
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (state.phase === "armed") {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `prewalk → ${targetLabel(state.target)}`));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function injectPlan(): void {
    if (state.phase !== "armed" || state.planInjected) return;
    state = { ...state, planInjected: true, continuePending: true };
    persist();
    pi.sendMessage(
      {
        customType: state.planMessageType ?? `${PLAN_MESSAGE_PREFIX}:${crypto.randomUUID()}`,
        content: PREWALK_PLAN_PROMPT,
        display: false,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  function restore(ctx: ExtensionContext): void {
    state = initialState();
    const entry = ctx.sessionManager
      .getEntries()
      .filter((candidate: { type: string; customType?: string }) =>
        candidate.type === "custom" && candidate.customType === ENTRY_TYPE)
      .pop() as { data?: unknown } | undefined;
    if (isState(entry?.data)) state = entry.data;
  }

  function findModel(ctx: ExtensionContext, spec: string): { model?: Model<any>; error?: string } {
    const resolved = resolveTarget(spec, ctx.modelRegistry.getAvailable());
    if (!resolved.model || resolved.error) return resolved;
    if (!ctx.modelRegistry.hasConfiguredAuth(resolved.model)) {
      return { error: `No configured credentials for ${resolved.model.provider}/${resolved.model.id}.` };
    }
    return resolved;
  }

  function arm(ctx: ExtensionContext, model: Model<any>, injectImmediately: boolean): void {
    if (state.phase === "armed") {
      ctx.ui.notify(`Prewalk is already armed for ${targetLabel(state.target)}.`, "warning");
      return;
    }
    state = {
      version: 1,
      phase: "armed",
      target: { provider: model.provider, id: model.id },
      planMessageType: `${PLAN_MESSAGE_PREFIX}:${crypto.randomUUID()}`,
      planInjected: false,
      continuePending: false,
      todoSeen: false,
      scrubPlan: true,
    };
    persist();
    updateStatus(ctx);
    ctx.ui.notify(
      `Prewalk armed: ${targetLabel(state.target)} after the first successful edit/write once todo is ready.`,
      "info",
    );
    if (injectImmediately) injectPlan();
  }

  function disable(ctx: ExtensionContext): void {
    state = {
      ...initialState(),
      scrubPlan: state.scrubPlan || state.planInjected,
    };
    persist();
    updateStatus(ctx);
    ctx.ui.notify("Prewalk disabled.", "info");
  }

  pi.registerCommand("prewalk", {
    description: "Arm a todo-gated switch to a fast executor model",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "status") {
        ctx.ui.notify(
          state.phase === "armed"
            ? `Prewalk armed for ${targetLabel(state.target)}.`
            : state.phase === "switched"
              ? `Prewalk switched to ${targetLabel(state.target)}.`
              : "Prewalk is idle.",
          "info",
        );
        return;
      }
      if (input === "off" || input === "disable") {
        disable(ctx);
        return;
      }

      const spec = input || configuredTarget(pi);
      if (!spec) {
        ctx.ui.notify(
          "Usage: /prewalk <provider/model>. Configure a default with --prewalk-into or PI_PREWALK_MODEL.",
          "warning",
        );
        return;
      }
      const resolved = findModel(ctx, spec);
      if (!resolved.model) {
        ctx.ui.notify(resolved.error ?? `Unable to resolve ${spec}.`, "error");
        return;
      }
      arm(ctx, resolved.model, true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    if (state.phase === "idle" && pi.getFlag("prewalk") === true) {
      const spec = configuredTarget(pi);
      if (!spec) {
        ctx.ui.notify("--prewalk requires --prewalk-into <provider/model> or PI_PREWALK_MODEL.", "warning");
      } else {
        const resolved = findModel(ctx, spec);
        if (resolved.model) arm(ctx, resolved.model, false);
        else ctx.ui.notify(resolved.error ?? `Unable to resolve ${spec}.`, "error");
      }
    }
    updateStatus(ctx);
  });

  pi.on("context", async (event) => {
    if (!state.scrubPlan) return;
    return {
      messages: event.messages.filter((message) => {
        const custom = message as { role?: string; customType?: string };
        if (custom.role !== "custom" || !custom.customType?.startsWith(`${PLAN_MESSAGE_PREFIX}:`)) return true;
        return state.phase === "armed" && custom.customType === state.planMessageType;
      }),
    };
  });

  pi.on("turn_end", async (event, ctx) => {
    if (state.phase !== "armed" || event.message.role !== "assistant") return;

    const successfulResults = event.toolResults.filter((result) => !result.isError);
    const todoSeenThisTurn = successfulResults.some((result) => result.toolName === "todo");
    if (todoSeenThisTurn && !state.todoSeen) state = { ...state, todoSeen: true };

    if (state.planInjected && event.toolResults.length > 0) {
      state = { ...state, continuePending: true };
    } else if (state.continuePending) {
      state = { ...state, continuePending: false };
      pi.sendMessage(
        { customType: CONTINUE_MESSAGE_TYPE, content: PREWALK_CONTINUE_PROMPT, display: false },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }

    const todoGateOpen = state.todoSeen || !pi.getActiveTools().includes("todo");
    const action = todoGateOpen
      ? successfulResults.find((result) =>
        ACTION_TOOLS.has(result.toolName) ||
        (result.toolName === "bash" && isApplyPatchCall(event.message, result.toolCallId)))
      : undefined;

    if (!action) {
      persist();
      if (!state.planInjected) {
        injectPlan();
        ctx.ui.notify("Prewalk injected the planning checkpoint.", "info");
      }
      return;
    }

    const target = state.target;
    if (!target) {
      disable(ctx);
      return;
    }
    const model = ctx.modelRegistry.find(target.provider, target.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
      state = { ...state, phase: "idle", scrubPlan: true, continuePending: false };
      persist();
      updateStatus(ctx);
      ctx.ui.notify(`Prewalk could not switch: ${targetLabel(target)} is unavailable.`, "error");
      return;
    }

    state = { ...state, scrubPlan: true, continuePending: false };
    persist();
    const switched = ctx.model?.provider === model.provider && ctx.model.id === model.id
      ? true
      : await pi.setModel(model);
    if (!switched) {
      state = { ...state, phase: "idle" };
      persist();
      updateStatus(ctx);
      ctx.ui.notify(`Prewalk could not switch to ${targetLabel(target)}.`, "error");
      return;
    }

    state = { ...state, phase: "switched" };
    persist();
    updateStatus(ctx);
    const actionLabel = action.toolName === "bash" ? "apply_patch" : action.toolName;
    ctx.ui.notify(`Prewalk switched to ${targetLabel(target)} after the first ${actionLabel}.`, "info");
    pi.sendMessage(
      { customType: CHECKLIST_MESSAGE_TYPE, content: PREWALK_CHECKLIST_PROMPT, display: false },
      { triggerTurn: true, deliverAs: "steer" },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
