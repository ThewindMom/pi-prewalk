import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PREWALK_CHECKLIST_PROMPT, PREWALK_CONTINUE_PROMPT, PREWALK_PLAN_PROMPT } from "./prompts.ts";

const ENTRY_TYPE = "pi-prewalk-state";
const STATUS_KEY = "pi-prewalk";
const PLAN_MESSAGE_PREFIX = "pi-prewalk-plan";
const CONTINUE_MESSAGE_TYPE = "pi-prewalk-continue";
const CHECKLIST_MESSAGE_TYPE = "pi-prewalk-checklist";
const ACTION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const APPLY_PATCH_COMMAND = /(?:^|(?:&&|\|\||\||;|\n)\s*)(?:[^\s;&|]*\/)?apply_patch(?=\s*(?:$|&&|\|\||;|\n|<<))/m;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type PrewalkThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PrewalkModelConfig {
  model: string;
  thinking?: PrewalkThinkingLevel;
}

export interface PrewalkConfig {
  enabled: boolean;
  planner?: PrewalkModelConfig;
  executor?: PrewalkModelConfig;
}

export interface PrewalkRuntimeOptions {
  configPath?: string;
  argv?: string[];
  readConfig?: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseModelConfig(value: unknown, field: string): PrewalkModelConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`"${field}" must be an object.`);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "model" && key !== "thinking")) {
    throw new Error(`"${field}" contains an unknown setting.`);
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new Error(`"${field}.model" must be a non-empty provider/model string.`);
  }
  if (value.thinking !== undefined && (
    typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking)
  )) {
    throw new Error(`"${field}.thinking" must be a valid thinking level.`);
  }
  return {
    model: value.model.trim(),
    thinking: value.thinking as PrewalkThinkingLevel | undefined,
  };
}

export function parsePrewalkConfig(value: unknown): PrewalkConfig {
  if (!isRecord(value)) throw new Error("Configuration must be a JSON object.");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "enabled" && key !== "planner" && key !== "executor")) {
    throw new Error("Configuration contains an unknown setting.");
  }
  if (typeof value.enabled !== "boolean") throw new Error('"enabled" must be a boolean.');
  const config = {
    enabled: value.enabled,
    planner: parseModelConfig(value.planner, "planner"),
    executor: parseModelConfig(value.executor, "executor"),
  };
  if (config.enabled && !config.executor) {
    throw new Error('"executor" is required when Prewalk is enabled.');
  }
  return config;
}

export function defaultConfigPath(): string {
  return join(getAgentDir(), "prewalk.json");
}

export function loadPrewalkConfig(
  path = defaultConfigPath(),
  readConfig: (path: string) => string = (configPath) => readFileSync(configPath, "utf8"),
): { config?: PrewalkConfig; error?: string } {
  try {
    return { config: parsePrewalkConfig(JSON.parse(readConfig(path))) };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function hasCliOption(argv: string[], names: string[]): boolean {
  return argv.some((argument) => names.some((name) => argument === name || argument.startsWith(`${name}=`)));
}

function hasConversation(entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): boolean {
  return entries.some((entry) => (
    entry.type === "message" ||
    entry.type === "compaction" ||
    entry.type === "branch_summary"
  ));
}

function parseCommandTarget(input: string): { spec: string; thinking?: PrewalkThinkingLevel; error?: string } {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { spec: "" };
  if (parts.length > 2) return { spec: "", error: "Usage: /prewalk <provider/model> [thinking]." };
  const thinking = parts[1];
  if (thinking !== undefined && !THINKING_LEVELS.has(thinking)) {
    return { spec: "", error: `"${thinking}" is not a valid thinking level.` };
  }
  return { spec: parts[0], thinking: thinking as PrewalkThinkingLevel | undefined };
}

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

function hasToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("content" in message)) return false;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) && content.some((part) => (
    !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall"
  ));
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
  executorThinking?: PrewalkThinkingLevel;
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
    (candidate.executorThinking === undefined || THINKING_LEVELS.has(candidate.executorThinking)) &&
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

function configuredTarget(pi: ExtensionAPI, config: PrewalkConfig | undefined): PrewalkModelConfig | undefined {
  const flag = pi.getFlag("prewalk-into");
  const thinkingFlag = pi.getFlag("prewalk-executor-thinking");
  const thinking = typeof thinkingFlag === "string" && THINKING_LEVELS.has(thinkingFlag)
    ? thinkingFlag as PrewalkThinkingLevel
    : undefined;
  if (typeof flag === "string" && flag.trim()) {
    return { model: flag.trim(), thinking: thinking ?? config?.executor?.thinking };
  }
  if (config?.executor) return { ...config.executor, thinking: thinking ?? config.executor.thinking };
  const environmentModel = process.env.PI_PREWALK_MODEL?.trim();
  return environmentModel ? { model: environmentModel, thinking } : undefined;
}

function prewalkExtension(pi: ExtensionAPI, options: PrewalkRuntimeOptions): void {
  let state = initialState();
  let config: PrewalkConfig | undefined;

  pi.registerFlag("prewalk", {
    description: "Start with Prewalk enabled",
    type: "boolean",
  });
  pi.registerFlag("no-prewalk", {
    description: "Disable automatic Prewalk configuration",
    type: "boolean",
  });
  pi.registerFlag("prewalk-into", {
    description: "Executor model for Prewalk (provider/model)",
    type: "string",
    default: "",
  });
  pi.registerFlag("prewalk-executor-thinking", {
    description: "Executor thinking level for Prewalk",
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

  function arm(
    ctx: ExtensionContext,
    model: Model<any>,
    injectImmediately: boolean,
    executorThinking?: PrewalkThinkingLevel,
  ): void {
    if (state.phase === "armed") {
      ctx.ui.notify(`Prewalk is already armed for ${targetLabel(state.target)}.`, "warning");
      return;
    }
    state = {
      version: 1,
      phase: "armed",
      target: { provider: model.provider, id: model.id },
      executorThinking,
      planMessageType: `${PLAN_MESSAGE_PREFIX}:${crypto.randomUUID()}`,
      planInjected: false,
      continuePending: false,
      todoSeen: false,
      scrubPlan: true,
    };
    persist();
    updateStatus(ctx);
    ctx.ui.notify(
      `Prewalk armed: ${targetLabel(state.target)} after the first successful edit, write, or apply_patch once todo is ready.`,
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

      const commandTarget = parseCommandTarget(input);
      if (commandTarget.error) {
        ctx.ui.notify(commandTarget.error, "warning");
        return;
      }
      const configured = configuredTarget(pi, config);
      const spec = commandTarget.spec || configured?.model;
      if (!spec) {
        ctx.ui.notify(
          "Usage: /prewalk <provider/model> [thinking]. Configure a default with prewalk.json or --prewalk-into.",
          "warning",
        );
        return;
      }
      const resolved = findModel(ctx, spec);
      if (!resolved.model) {
        ctx.ui.notify(resolved.error ?? `Unable to resolve ${spec}.`, "error");
        return;
      }
      arm(ctx, resolved.model, true, commandTarget.thinking ?? configured?.thinking);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    restore(ctx);
    const loaded = loadPrewalkConfig(options.configPath, options.readConfig);
    config = loaded.config;
    if (loaded.error) ctx.ui.notify(`Invalid prewalk.json: ${loaded.error}`, "error");

    const entries = ctx.sessionManager.getEntries();
    const isNewSession = event.reason === "new" || (event.reason === "startup" && !hasConversation(entries));
    const cliDisabled = pi.getFlag("no-prewalk") === true;
    const cliEnabled = pi.getFlag("prewalk") === true;
    const automaticallyEnabled = !cliDisabled && (cliEnabled || config?.enabled === true);

    if (state.phase === "idle" && isNewSession && automaticallyEnabled) {
      const argv = options.argv ?? process.argv.slice(2);
      if (config?.planner && !hasCliOption(argv, ["--model", "-m"])) {
        const planner = findModel(ctx, config.planner.model);
        if (!planner.model || !await pi.setModel(planner.model)) {
          ctx.ui.notify(planner.error ?? `Unable to select planner ${config.planner.model}.`, "error");
          updateStatus(ctx);
          return;
        }
      }
      if (
        config?.planner?.thinking &&
        !hasCliOption(argv, ["--thinking"]) &&
        !hasCliOption(argv, ["--model", "-m"])
      ) {
        pi.setThinkingLevel(config.planner.thinking);
      }

      const target = configuredTarget(pi, config);
      if (!target) {
        ctx.ui.notify("Prewalk requires an executor in prewalk.json or --prewalk-into <provider/model>.", "warning");
      } else {
        const resolved = findModel(ctx, target.model);
        if (resolved.model) arm(ctx, resolved.model, false, target.thinking);
        else ctx.ui.notify(resolved.error ?? `Unable to resolve ${target.model}.`, "error");
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

  pi.on("message_end", async (event, ctx) => {
    if (state.phase !== "armed" || event.message.role !== "assistant") return;

    if (!state.planInjected) {
      injectPlan();
      ctx.ui.notify("Prewalk injected the planning checkpoint.", "info");
      return;
    }
    if (!state.continuePending || hasToolCall(event.message)) return;

    state = { ...state, continuePending: false };
    persist();
    pi.sendMessage(
      { customType: CONTINUE_MESSAGE_TYPE, content: PREWALK_CONTINUE_PROMPT, display: false },
      { triggerTurn: true, deliverAs: "steer" },
    );
  });

  pi.on("turn_end", async (event, ctx) => {
    if (state.phase !== "armed" || event.message.role !== "assistant") return;

    const successfulResults = event.toolResults.filter((result) => !result.isError);
    const todoSeenThisTurn = successfulResults.some((result) => result.toolName === "todo");
    if (todoSeenThisTurn && !state.todoSeen) state = { ...state, todoSeen: true };

    if (state.planInjected && event.toolResults.length > 0) {
      state = { ...state, continuePending: true };
    }

    const todoGateOpen = state.todoSeen || !pi.getActiveTools().includes("todo");
    const action = todoGateOpen
      ? successfulResults.find((result) =>
        ACTION_TOOLS.has(result.toolName) ||
        (result.toolName === "bash" && isApplyPatchCall(event.message, result.toolCallId)))
      : undefined;

    if (!action) {
      persist();
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

    const sameModel = ctx.model?.provider === model.provider && ctx.model.id === model.id;
    if (sameModel) {
      state = { ...state, phase: "idle", scrubPlan: true, continuePending: false };
      persist();
      updateStatus(ctx);
      return;
    }

    state = { ...state, scrubPlan: true, continuePending: false };
    persist();
    const switched = await pi.setModel(model);
    if (!switched) {
      state = { ...state, phase: "idle" };
      persist();
      updateStatus(ctx);
      ctx.ui.notify(`Prewalk could not switch to ${targetLabel(target)}.`, "error");
      return;
    }
    if (state.executorThinking) pi.setThinkingLevel(state.executorThinking);

    state = { ...state, phase: "switched" };
    persist();
    updateStatus(ctx);
    const actionLabel = action.toolName === "bash" ? "apply_patch" : action.toolName;
    ctx.ui.notify(`Prewalk switched to ${targetLabel(target)} after the first ${actionLabel}.`, "info");
    pi.sendMessage(
      { customType: CHECKLIST_MESSAGE_TYPE, content: PREWALK_CHECKLIST_PROMPT, display: false },
      { deliverAs: "steer" },
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export function createPrewalkExtension(options: PrewalkRuntimeOptions = {}) {
  return (pi: ExtensionAPI): void => prewalkExtension(pi, options);
}

export default createPrewalkExtension();
