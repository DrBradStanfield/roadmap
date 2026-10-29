// The lab reading for the App Store preview video (ios/scripts/app-store-video.sh), on this Mac.
// The simulator has no App Attest, so a DEBUG simulator build sends the dev header to a server
// on this Mac (ServerConfig.swift, US-52 AC3); the UI test points the app at port 3100 through
// HEALTH_ROADMAP_SERVER, leaving 3000 to other runs. This serves ONLY the app's lab-import route,
// through the production pieces appLabImport chains (appGate, the request schema, extractOneFile;
// app-routes.server itself pulls in the Shopify server, which needs the database), with the
// bypass allowed as AC3 allows it: NODE_ENV=development and APP_ATTEST_DEV_BYPASS=1, local only.
// The model really reads the report; nothing is faked. Only ANTHROPIC_API_KEY is read from .env.
//   npx tsx ios/scripts/app-store-video-lab-server.mts   (from the repo root)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const key = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith('ANTHROPIC_API_KEY='));
if (!key) throw new Error('No ANTHROPIC_API_KEY in .env');
process.env.ANTHROPIC_API_KEY = key.slice('ANTHROPIC_API_KEY='.length).replace(/^["']|["']$/g, '').trim();
Object.assign(process.env, { NODE_ENV: 'development', APP_ATTEST_DEV_BYPASS: '1' });

const { appGate } = await import('../../app/lib/app-gate.server');
const { extractOneFile } = await import('../../app/lib/lab-extract-one.server');
const { labImportRequestSchema } = await import('../../packages/health-core/src/validation');

/** appLabImport (app/lib/app-routes.server.ts) without the machine-wide daily ceiling. */
async function appLabImport(request: Request): Promise<Response> {
  const gate = await appGate(request, { kind: 'lab', bodyCap: 25 * 1024 * 1024 });
  if (gate instanceof Response) return gate;
  const parsed = labImportRequestSchema.safeParse(JSON.parse(gate.body.toString('utf8')));
  if (!parsed.success) return Response.json({ success: false, error: 'Invalid request' }, { status: 400 });
  return extractOneFile(parsed.data);
}

createServer(async (req, res) => {
  if (req.url !== '/api/app/v1/lab-import') { res.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const answer = await appLabImport(new Request(`http://127.0.0.1:3100${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }));
  console.log(JSON.stringify({ evt: 'lab_import', status: answer.status })); // the status only, never the values
  res.writeHead(answer.status, { 'Content-Type': 'application/json' });
  res.end(Buffer.from(await answer.arrayBuffer()));
}).listen(3100, '127.0.0.1', () => console.log('lab server on 127.0.0.1:3100'));
