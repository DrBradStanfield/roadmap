// Builds the OpenAI plugin ZIP for Health by Dr Brad from docs/chatgpt-review/plugin/, plus the assets
// taken from their sources at build time (US-32; listing and test cases: docs/chatgpt-app-listing.md).
//
//   node docs/chatgpt-review/build-plugin-zip.mjs           validate, then write health-by-dr-brad-<version>.zip
//   node docs/chatgpt-review/build-plugin-zip.mjs --check   validate only
//
// OpenAI publishes no validator, so this one encodes the documented rules, cited by their error
// codes: the Agent Plugins schemas (https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and
// mcp.schema.json) and https://developers.openai.com/plugins/deploy/submission-errors, including the
// stricter final-submission limits. Passing here does not mean the dashboard's checks pass.
//
// Reviewer credentials never enter the package: the ZIP rejects them, and they are typed into the
// dashboard's Review details (docs/chatgpt-review/review-details.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'plugin');
// Archive path -> source file. The logo is the app icon itself, so no copy of it is committed.
const ASSETS = { 'assets/logo.png': path.join(HERE, '../../demo-video/public/app-icon.png') };
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const CATEGORIES = ['Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics',
  'Communication', 'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other'];
// The tool names the server publishes, read from the one list they live in.
const TOOL_NAMES = [...fs.readFileSync(path.join(HERE, '../../packages/health-core/src/product-events.ts'), 'utf8')
  .match(/MCP_TOOL_NAMES = \[([^\]]*)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const errors = [];
const warnings = [];
const fail = (code, msg) => errors.push(`${code}: ${msg}`);

// "Supported text": no control characters (bar a line break where allowed), no Unicode line or
// paragraph separators, no invisible formatting characters.
const UNSUPPORTED = new RegExp(`[${[[0x0, 0x9], [0xb, 0x1f], [0x7f, 0x7f], [0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
  .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`, 'u');
function text(code, value, max, { multiline = false, required = true } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || !value.trim()) return fail(code, 'required, non-empty string');
  if (value.length > max) fail(code, `${value.length} characters, limit ${max}`);
  if (UNSUPPORTED.test(value) || (!multiline && /\n/.test(value))) fail(code, 'unsupported character or line break');
}
function httpsUrl(code, value, max) {
  let url;
  try { url = new URL(value); } catch { return fail(code, 'not a URL'); }
  if (url.protocol !== 'https:' || !url.host || url.username || url.password) fail(code, 'must be HTTPS, with no credentials');
  if (value.length > max) fail(code, `longer than ${max}`);
}
function onlyKeys(code, obj, allowed) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(code, `unexpected key "${key}"`);
}

/** Square, 48 to 4096 px, at most 5 MiB, content matching the extension. PNG is all we ship. */
function image(code, rel) {
  if (typeof rel !== 'string' || !rel.startsWith('./')) return fail(code, 'must be a ./-prefixed path');
  const file = ASSETS[rel.slice(2)];
  if (!file || !fs.existsSync(file)) return fail(code, `${rel} is missing`);
  const buf = fs.readFileSync(file);
  if (buf.length > 5 * 1024 * 1024) fail(code, `${rel} is over 5 MiB`);
  if (!rel.endsWith('.png') || buf.toString('latin1', 1, 4) !== 'PNG') return fail(code, `${rel} must be a real PNG`);
  const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (w !== h || w < 48 || w > 4096) fail(code, `${rel} is ${w}x${h}: square, 48 to 4096 px`);
}

function validatePlugin(p) {
  // plugin.schema.json: required $schema and name, nothing else at the root or in author.
  if (p.$schema !== PLUGIN_SCHEMA) fail('plugin_manifest_missing', `$schema must be ${PLUGIN_SCHEMA}`);
  onlyKeys('plugin.schema.json', p, ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  // The schema's name pattern and OpenAI's, intersected: no dots, no underscores, no capitals.
  if (typeof p.name !== 'string' || p.name.length > 64 || !/^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p.name)) {
    fail('plugin_name_format', 'lowercase letters, digits and single hyphens, at most 64');
  }
  if (typeof p.version !== 'string' || p.version.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(p.version)) fail('plugin_version_not_semver', 'semantic version required');
  text('plugin_description', p.description, 1024, { multiline: true });
  if (!p.author || typeof p.author !== 'object') return fail('plugin_developer_missing', 'author.name is required');
  onlyKeys('plugin.schema.json', p.author, ['name', 'email', 'url']);
  text('plugin_author_name', p.author.name, 120);
  if (p.author.url !== undefined) httpsUrl('plugin_author_url', p.author.url, 2048);
  if (p.homepage !== undefined) httpsUrl('plugin_homepage', p.homepage, 2048);

  const ext = p.extensions?.['com.openai'];
  if (!ext || typeof ext !== 'object') return fail('extensions.com.openai', 'missing');
  // No apps or hooks: ZIPs carrying them cannot be submitted. No screenshots: we return no UI.
  onlyKeys('extensions.com.openai', ext, ['interface', 'review', 'publication', 'onboardingSkill']);

  const ui = ext.interface ?? {};
  onlyKeys('interface', ui, ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category', 'capabilities',
    'websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL', 'defaultPrompt', 'brandColor', 'brandColorDark',
    'composerIcon', 'composerIconDark', 'logo', 'logoDark']);
  text('submission_display_name', ui.displayName, 30);
  text('submission_subtitle', ui.shortDescription, 30);
  text('submission_description', ui.longDescription, 4000, { multiline: true });
  text('submission_developer_name', ui.developerName, 80);
  if (!CATEGORIES.includes(ui.category)) fail('plugin_category_unknown', `"${ui.category}"`);
  if (!Array.isArray(ui.capabilities) || ui.capabilities.length > 20) fail('plugin_capabilities_too_many', 'a list of at most 20');
  for (const c of ui.capabilities ?? []) text('plugin_capability_invalid', c, 120);
  for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) httpsUrl(`interface.${key}`, ui[key] ?? '', 1024);
  const prompts = [].concat(ui.defaultPrompt ?? []);
  if (prompts.length > 3) fail('plugin_default_prompt_too_many', `${prompts.length}, limit 3`);
  for (const s of prompts) {
    text('plugin_default_prompt', s, 128);
    if (/@\S/.test(s)) fail('plugin_default_prompt_mention', s);
  }
  const norm = prompts.map((s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim());
  if (new Set(norm).size !== norm.length) fail('plugin_default_prompt_duplicate', 'starter prompts must be unique');
  image('plugin_logo_path_missing', ui.logo);
  image('plugin_composer_icon_path_missing', ui.composerIcon);

  const review = ext.review ?? {};
  const cases = review.test_cases ?? {};
  if (cases.positive?.length !== 5) fail('review.test_cases.positive', 'exactly five required for MCP review');
  if (cases.negative?.length !== 3) fail('review.test_cases.negative', 'exactly three required for MCP review');
  for (const [kind, list] of Object.entries(cases)) for (const [i, c] of (list ?? []).entries()) {
    const at = `review.test_cases.${kind}[${i}]`;
    onlyKeys(at, c, ['description', 'prompt', 'tools_triggered', 'expected_behavior', 'file_attachment_urls', 'expected_output_url']);
    text(`${at}.description`, c.description, 4000, { multiline: true });
    text(`${at}.prompt`, c.prompt, 4000, { multiline: true });
    if (kind === 'positive') {
      text(`${at}.expected_behavior`, c.expected_behavior, 4000, { multiline: true });
      for (const tool of String(c.tools_triggered ?? '').split(',').map((t) => t.trim())) {
        if (!TOOL_NAMES.includes(tool)) fail(`${at}.tools_triggered`, `"${tool}" is not a tool the server publishes`);
      }
    }
    for (const u of c.file_attachment_urls ?? []) httpsUrl(`${at}.file_attachment_urls`, u, 2048);
  }
  if (review.demo_recording_url === undefined) warnings.push('review.demo_recording_url is absent: required for MCP review, so set it in the dashboard (or here) before submitting.');
  else httpsUrl('review.demo_recording_url', review.demo_recording_url, 2048);
  if (typeof review.commerce !== 'boolean') fail('review.commerce', 'must be true or false');

  const pub = ext.publication ?? {};
  if (!Array.isArray(pub.countries) || pub.countries.some((c) => !/^[A-Z]{2}$/.test(c))) fail('publication.countries', 'uppercase country codes, [] for everywhere');
  text('publication.release_notes', pub.release_notes, 4000, { multiline: true });
}

function validateMcp(m) {
  if (m.$schema !== MCP_SCHEMA) fail('mcp.schema.json', `$schema must be ${MCP_SCHEMA}`);
  onlyKeys('mcp.schema.json', m, ['$schema', 'mcpServers']);
  const servers = Object.entries(m.mcpServers ?? {});
  // Plugin-level review.test_cases require exactly one server.
  if (servers.length !== 1) return fail('mcp.json', 'exactly one server');
  const [name, server] = servers[0];
  if (!name.trim()) fail('mcp_server_name_empty', 'server name');
  onlyKeys('mcp.schema.json', server, ['type', 'url']);
  if (server.type !== 'streamable-http') fail('mcp.json', 'type must be streamable-http');
  httpsUrl('mcp.json url', server.url ?? '', 2048);
}

/** Every file under the plugin root except dotfiles, with posix paths and archive path rules. */
function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

const committed = listFiles(ROOT);
// skills/ is refused below and assets/ is one level deep, so archive_member_path_too_deep (20 levels) cannot arise.
// Assets come only from ASSETS: a committed copy would drift from its source.
for (const f of committed) if (!/^(plugin\.json|mcp\.json|skills\/.+)$/.test(f)) fail('package layout', `unexpected file ${f}`);
const files = [...committed, ...Object.keys(ASSETS)].sort();
if (files.some((f) => f.startsWith('skills/'))) fail('skills', 'this package ships no skills; validate SKILL.md front matter here before adding one');
const raw = Object.fromEntries(files.filter((f) => f.endsWith('.json')).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
for (const [f, body] of Object.entries(raw)) {
  // Credentials and reviewer instructions are rejected by the ZIP and belong in the dashboard.
  if (/"(test_credentials|reviewer_instructions)"|\[REVIEWER_/.test(body)) fail('credentials', `${f} carries reviewer credentials or instructions`);
}
let plugin;
let mcp;
try { plugin = JSON.parse(raw['plugin.json']); } catch (e) { fail('plugin_manifest_json_malformed', e.message); }
try { mcp = JSON.parse(raw['mcp.json']); } catch (e) { fail('mcp_manifest_json_malformed', e.message); }
if (plugin) validatePlugin(plugin);
if (mcp) validateMcp(mcp);

for (const w of warnings) console.log(`warning  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error    ${e}`);
  process.exit(1);
}
console.log(`ok       ${plugin.name} ${plugin.version}: ${files.length} files valid`);
if (process.argv.includes('--check')) process.exit(0);

// A fixed date and sorted entries, so the same folder always gives the same bytes.
const zip = new JSZip();
const date = new Date('2026-01-01T00:00:00Z');
for (const f of files) zip.file(f, fs.readFileSync(ASSETS[f] ?? path.join(ROOT, f)), { date, createFolders: false });
const out = path.join(HERE, `${plugin.name}-${plugin.version}.zip`);
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
if (bytes.length > 100 * 1024 * 1024) throw new Error('archive_too_large');
fs.writeFileSync(out, bytes);

// Read it back: the archive must hold exactly the validated files at its root.
const back = Object.keys((await JSZip.loadAsync(bytes)).files).sort();
if (JSON.stringify(back) !== JSON.stringify([...files].sort())) throw new Error(`archive holds ${back.join(', ')}`);
console.log(`wrote    ${path.relative(process.cwd(), out)} (${bytes.length} bytes, ${back.length} entries)`);
