const TOP_KEYS = ["status", "target", "summary", "findings"];
const FINDING_KEYS = ["id", "severity", "blocks_merge", "file", "line", "summary", "failure_scenario", "evidence", "remedy"];
const schema = {
  type: "object", additionalProperties: false,
  required: ["status", "target", "summary", "findings"],
  properties: {
    status: { type: "string", enum: ["complete", "incomplete"] },
    target: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "severity", "blocks_merge", "file", "line", "summary", "failure_scenario", "evidence", "remedy"],
        properties: {
          id: { type: "string" }, severity: { type: "string", enum: ["high", "medium", "low"] },
          blocks_merge: { type: "boolean" }, file: { type: "string" }, line: { type: "integer" },
          summary: { type: "string" }, failure_scenario: { type: "string" }, evidence: { type: "string" }, remedy: { type: "string" },
        },
      },
    },
  },
};
function validate(r) {
  const str = (v) => typeof v === "string";
  if (typeof r !== "object" || r === null || Array.isArray(r)) return "not an object";
  // Diagnostics name positions, never the model's text: a property NAME can carry a value too.
  if (Object.keys(r).some((k) => !TOP_KEYS.includes(k))) return "undeclared top-level field";
  if (!["complete", "incomplete"].includes(r.status)) return "status";
  if (!str(r.target) || !str(r.summary) || !Array.isArray(r.findings)) return "top-level fields";
  for (const [i, f] of r.findings.entries()) {
    if (typeof f !== "object" || f === null) return `findings[${i}]`;
    if (Object.keys(f).some((k) => !FINDING_KEYS.includes(k))) return `findings[${i}] has an undeclared field`;
    for (const k of ["id", "file", "summary", "failure_scenario", "evidence", "remedy"]) if (!str(f[k])) return `findings[${i}].${k}`;
    if (!["high", "medium", "low"].includes(f.severity)) return `findings[${i}].severity`;
    if (typeof f.blocks_merge !== "boolean") return `findings[${i}].blocks_merge`;
    if (!Number.isInteger(f.line)) return `findings[${i}].line`;
  }
  return null;
}
/** Only the declared fields, copied one by one: nothing else the model wrote reaches a report. */
function pick(r) {
  return { status: r.status, target: r.target, summary: r.summary, findings: r.findings.map((f) => Object.fromEntries(FINDING_KEYS.map((k) => [k, f[k]]))) };
}
// Strict: the authority must be a bare host (and port) that the WHATWG parser agrees on, so "https://github.com\\@evil"
// (github.com to Node, evil to an RFC parser) or any userinfo, space or escape there is unresolved, never "expected".
const urlHost = (u) => {
  const m = typeof u === "string" ? /^https?:\/\/([a-z0-9.-]+)(:\d+)?([/?#]|$)/i.exec(u) : null;
  if (!m) return null;
  try { const h = new URL(u).hostname.toLowerCase(); return h === m[1].toLowerCase() ? h : null; } catch { return null; }
};
const plainHost = (h) => typeof h === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) && !/^[0-9.]+$/.test(h) && h.length <= 253;
const isFetch = (it) => it.action?.type !== "search" && !(it.action?.type === "find_in_page" && it.action?.url == null);
const ALLOWED_TOOLS = ["read_record", "get_plan", "list_mcp_resources", "list_mcp_resource_templates"];
const READ_TOOLS = ["read_record", "get_plan"];
const nonEmptyObject = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
const nonEmptyBlock = (b) => b && typeof b === "object" && (b.type === "text" ? typeof b.text === "string" && b.text.trim().length > 0 : Object.keys(b).length > 1);
// The exec event stream spells it structured_content; the MCP payload inside spells it structuredContent. Both strings are in the 0.154 binary.
const payloadOk = (r) => r && r.isError !== true && ((Array.isArray(r.content) && r.content.some(nonEmptyBlock)) || nonEmptyObject(r.structured_content ?? r.structuredContent));
export { ALLOWED_TOOLS, isFetch, payloadOk, pick, plainHost, READ_TOOLS, schema, urlHost, validate };
