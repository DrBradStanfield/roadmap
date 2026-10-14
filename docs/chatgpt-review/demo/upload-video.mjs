// Upload the rendered review demo to the edu store's Shopify Files and print its CDN URL,
// which goes into plugin.json's demo_recording_url (docs/chatgpt-review/demo-script.md).
// Usage: SHOPIFY_EDU_SHOP=… SHOPIFY_EDU_ACCESS_TOKEN=… node docs/chatgpt-review/demo/upload-video.mjs [file]
// Needs write_files. The token is never printed.
import fs from 'node:fs';
import path from 'node:path';

const API = '2025-07';
const shop = process.env.SHOPIFY_EDU_SHOP;
const token = process.env.SHOPIFY_EDU_ACCESS_TOKEN;
if (!shop || !token) throw new Error('SHOPIFY_EDU_SHOP and SHOPIFY_EDU_ACCESS_TOKEN are needed');
// The token goes only to a Shopify store's own admin host, never to a configured look-alike.
if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('SHOPIFY_EDU_SHOP must be <store>.myshopify.com');
const file = process.argv[2] ?? path.join(import.meta.dirname, 'out/review-demo.mp4');
const bytes = fs.readFileSync(file);

async function gql(query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const staged = await gql(
  `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
     stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
  { input: [{ filename: path.basename(file), mimeType: 'video/mp4', resource: 'VIDEO', fileSize: String(bytes.length), httpMethod: 'POST' }] },
);
const target = staged.stagedUploadsCreate.stagedTargets[0];
if (!target) throw new Error(JSON.stringify(staged.stagedUploadsCreate.userErrors));
const form = new FormData();
for (const { name, value } of target.parameters) form.append(name, value);
form.append('file', new Blob([bytes], { type: 'video/mp4' }), path.basename(file));
const up = await fetch(target.url, { method: 'POST', body: form });
if (!up.ok && up.status !== 201 && up.status !== 204) throw new Error(`upload HTTP ${up.status}`);

const created = await gql(
  `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message } } }`,
  { files: [{ originalSource: target.resourceUrl, contentType: 'VIDEO', alt: 'Health by Dr Brad: ChatGPT app review demo' }] },
);
const id = created.fileCreate.files[0]?.id;
if (!id) throw new Error(JSON.stringify(created.fileCreate.userErrors));
for (let i = 0; i < 60; i++) {
  const { node } = await gql(`query($id: ID!) { node(id: $id) { ... on Video { fileStatus sources { url mimeType height } originalSource { url } } } }`, { id });
  if (node?.fileStatus === 'READY') {
    const best = (node.sources ?? []).filter((s) => s.mimeType === 'video/mp4').sort((a, b) => b.height - a.height)[0];
    console.log(JSON.stringify({ id, url: best?.url ?? node.originalSource?.url, original: node.originalSource?.url }));
    process.exit(0);
  }
  if (node?.fileStatus === 'FAILED') throw new Error('Shopify could not process the video');
  await new Promise((r) => setTimeout(r, 5000));
}
throw new Error('Video still processing after 5 minutes');
