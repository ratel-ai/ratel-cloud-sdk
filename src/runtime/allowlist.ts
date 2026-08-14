/** Frozen remotely publishable v1 event names from ADR-0020. */
export const RUNTIME_EVENT_TYPES = [
  "search",
  "skill_search",
  "gateway_search",
  "invoke_start",
  "invoke_end",
  "invoke_error",
  "gateway_invoke",
  "gateway_error",
  "skill_invoke",
  "index_churn",
  "skill_churn",
  "upstream_register",
  "upstream_invoke",
  "upstream_error",
  "auth_refresh",
  "auth_needs",
  "auth_flow_start",
  "auth_flow_end",
  "experiment_selection",
  "experiment_results",
  "experiment_comparison",
  "experiment_skip",
  "experiment_fallback",
  "experiment_drop",
  "experiment_invocation",
  "experiment_outcome",
  "events_dropped",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

const RUNTIME_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUNTIME_EVENT_TYPES);

/** Whether one runtime event type may leave the process toward Ratel Cloud. */
export function isRemotelyPublishable(type: string): boolean {
  return RUNTIME_EVENT_TYPE_SET.has(type);
}
