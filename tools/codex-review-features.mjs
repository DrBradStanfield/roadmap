// The codex feature surface tools/codex-review.mjs allows (US-40 AC19, 2026-11-27). Data and pure functions only.
// The wrapper asks the binary for `features list` before the snapshot, disables what it must, and stops the run
// (E_UNKNOWN_FEATURES) when any feature is still enabled that is not judged below, so an updated CLI cannot add a
// capability unseen. An unknown --disable name exits 1, so the conditional disables follow what the binary lists.

/** Always disabled (AC3); every supported CLI lists them. */
export const DISABLE_ALWAYS = ["apps", "image_generation", "browser_use", "computer_use", "plugins", "memories", "skill_search", "multi_agent"];

/** Disabled when the binary lists them: sub-agents, agent messaging and delegation; browser and local automation; then what a review has no use for (2026-11-27 ruling). */
export const DISABLE_IF_LISTED = [
  "multi_agent_v2", "multi_agent_v2_dynamic_tools", "multi_agent_mode", "agent_message_board", "agent_message_board_mcp",
  "runtime_agent_instances", "subagent_default_context_limits", "subagent_thread_environments", "send_async_message",
  "send_message_to_user_async", "wake_on_agent_messages", "defer_mailbox_preemption", "enable_fanout", "collaboration_modes",
  "guardian_native_multi_agent_history", "external_agent_memory_import", "use_agent_identity",
  "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "in_app_local_automation",
  "hooks", "daemon_auto_start", "remote_plugin", "plugin_sharing", "skill_mcp_dependency_install", "tool_suggest", "goals",
  "guardian_approval", "worktrees", "in_app_chat", "in_app_dictation", "in_app_updates", "in_app_voice", "realtime_conversation",
  "browser_annotation_api",
];

const REMOVED = "stage removed in 0.171: accepted for old configs, no effect";
const TUI = "interactive TUI or desktop app only; codex exec has no UI";
/**
 * Features allowed to stay enabled, each with why. Seeded 2026-11-27 from codex-cli 0.171.0-alpha.13.2 after the disables
 * above (0.163.0's enabled set is a subset). "Judged" is a reading of the name and stage, not a probe of what it does.
 */
export const INERT = {
  api_key_cyber_access_programs: "API-key accounts only; the run stops before exec unless `login status` reports a ChatGPT login (checkLogin)",
  api_key_model_discovery: "API-key accounts only; the run stops before exec unless `login status` reports a ChatGPT login (checkLogin)",
  auth_elicitation: "login prompts; exec has no user to prompt",
  bedrock_setup_wizard: TUI,
  cli_daybreak: "CLI presentation layer",
  code_mode_host: "how tool calls are hosted in the session; same sandbox",
  code_mode_host_grpc: "transport for code_mode_host; same sandbox",
  code_mode_host_output_truncation: "truncates tool output",
  code_mode_interrupt: "interrupts a running tool call",
  compaction_image_budget: "context compaction budget",
  content_item_kinds: "message content types",
  deferred_tool_world_state: "tool-state bookkeeping",
  enable_request_compression: "compresses requests to the model API",
  fast_mode: "model speed tier",
  guardian_include_additional_context: "context for guardian_approval",
  guardian_reuse_parent_compaction: "context for guardian_approval",
  incremental_tools: "tool list delivery",
  incremental_tools_legacy: "tool list delivery",
  incremental_tools_legacy_gcp: "tool list delivery",
  instant_interrupt: "interrupt handling",
  item_ids: REMOVED,
  mcp_oauth_refresh_coordination: "OAuth refresh for MCP servers; only the --record stdio server is configured",
  mentions_v2: "@-mentions in the composer",
  prediction_preserve_parent_tools: "tool list bookkeeping",
  reasoning_effort_override: "lets the -c model_reasoning_effort setting apply",
  resize_all_images: REMOVED,
  retain_client_tool_outputs: "keeps tool outputs in context",
  shell_snapshot: "snapshots the shell environment for commands; same sandbox",
  shell_tool: "the read-only shell the review needs",
  sleep_tool: "lets the model wait",
  sqlite: REMOVED,
  steer: REMOVED,
  system_proxy_fallback: "network proxy fallback for the model API connection",
  terminal_resize_reflow: REMOVED,
  tool_call_mcp_elicitation: "MCP elicitation prompts; exec has no user to prompt",
  tool_search_always_defer_mcp_tools: REMOVED,
  tui_app_server: REMOVED,
  tui_workspace: TUI,
  ultrafast_mode: "model speed tier",
  unbounded_connection_retries: "retries the model API connection",
  unified_exec: "how shell commands run; same sandbox",
  unified_exec_tty: "TTY for unified_exec; same sandbox",
  unified_image_budget: "image budget in context",
  untrusted_as_tool_output: "marks untrusted text as tool output",
  view_image: "reads an image file the sandbox can already read",
  workspace_dependencies: "reads workspace dependency metadata; same sandbox",
  write_stdin_approval: "approval before writing to a running command's stdin",
};

/**
 * Named in DISABLE_IF_LISTED, yet still enabled after --disable: allowed ONLY on the version and at the stage where that
 * was seen (2026-11-27, `features list` under the wrapper's flags; both are disabled on 0.163.0). Anywhere else, refused.
 */
export const CANNOT_DISABLE = {
  realtime_conversation: { version: "codex-cli 0.171.0-alpha.13.2", stage: "removed" },
  worktrees: { version: "codex-cli 0.171.0-alpha.13.2", stage: "removed" },
};

/** INERT entries whose only reason is the `removed` stage (Codex R7): judged at that stage alone. */
const REMOVED_ONLY = new Set(["item_ids", "resize_all_images", "sqlite", "steer", "terminal_resize_reflow", "tool_search_always_defer_mcp_tools", "tui_app_server"]);

/** The child's whole environment (CR2): only what the CLI needs to find itself and its login; never an API-key variable. */
export const launchEnv = (parent) => ({ ...Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "CODEX_HOME"].filter((k) => parent[k]).map((k) => [k, parent[k]])), CI: "1" });

/**
 * The -c settings of every codex call: search mode (AC14), core shell env, high effort, no project docs. No login method is
 * forced: both supported CLIs carry "ChatGPT login is required, but an API key is currently being used. Logging out.", so
 * forcing one could sign the caller out of a stored login of the other kind (Codex R4, PR 2222e); the env allow-list keeps
 * API-key variables from the child instead.
 */
export const configArgs = (webAccess) => ["-c", `web_search="${webAccess}"`, "-c", 'shell_environment_policy.inherit="core"', "-c", 'model_reasoning_effort="high"',
  "-c", "project_doc_max_bytes=0", "-c", "project_doc_fallback_filenames=[]"];

/** Builds where AC14 showed hosted search stays cached-only on a cache miss (probe 2026-10-03). Nowhere else is "cached" trusted. */
const CACHED_VERIFIED = ["codex-cli 0.159.0-alpha.12.1"];
/** The search mode a run uses (Codex R3, PR 2222e): --live keeps its own rules; else cached on a verified build, else disabled. */
export const searchMode = (live, version) => (live ? "live" : CACHED_VERIFIED.includes(version) ? "cached" : "disabled");
/** A `--version` line this wrapper recognises. */
export const VERSION_LINE = /^codex-cli \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * `features list` text as { features: [{ name, stage, enabled }] }, or { error } when any non-blank row is not exactly
 * `<name> <stage> true|false`, a name repeats, or there is no row (Codex R2: a row the parser cannot read is never skipped).
 * The error names a row by number only: the CLI's own text never reaches the report.
 */
export function parseFeatures(text) {
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const features = [];
  for (const [i, row] of rows.entries()) {
    const m = /^([a-z0-9_.]+)\s+(under development|stable|experimental|deprecated|removed)\s+(true|false)$/.exec(row); // the stages both fixtures use
    if (!m) return { error: `row ${i + 1} is not "<name> <stage> true|false"` };
    features.push({ name: m[1], stage: m[2], enabled: m[3] === "true" });
  }
  if (!features.length) return { error: "no rows" };
  if (new Set(features.map((f) => f.name)).size !== features.length) return { error: "a feature is listed twice" };
  return { features };
}

/** The --disable arguments for a binary that lists `names`. */
export const disableArgs = (names) => [...DISABLE_ALWAYS, ...DISABLE_IF_LISTED.filter((n) => names.includes(n))].flatMap((n) => ["--disable", n]);

/**
 * Enabled features no one has judged, sorted. An entry judged inert only because its stage is `removed` holds only at that
 * stage (Codex R7); a CANNOT_DISABLE entry only on its own version and stage.
 */
export const unjudged = (features, version) => features.filter((f) => f.enabled && !(Object.hasOwn(INERT, f.name) && (!REMOVED_ONLY.has(f.name) || f.stage === "removed"))
  && !(Object.hasOwn(CANNOT_DISABLE, f.name) && CANNOT_DISABLE[f.name].version === version && CANNOT_DISABLE[f.name].stage === f.stage)).map((f) => f.name).sort();
