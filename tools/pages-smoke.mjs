// Pages smoke (deploy.yml, job pages-smoke): the GitHub Pages app boots clean in real WebKit
// on an iPhone 13 viewport, with the widget mounted and no page errors. It runs before
// production is touched. Moved out of the workflow's inline heredoc so it can be read and run
// by hand: `node tools/pages-smoke.mjs` (needs `npx playwright install webkit`).
// It lives in the repo, not /tmp, because Node resolves 'playwright' from the script's path.
import { webkit, devices } from 'playwright'

const browser = await webkit.launch()
const page = await browser.newPage({ ...devices['iPhone 13'] })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
await page.goto('https://drbradstanfield.github.io/roadmap/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('#health-tool-root', { timeout: 30000 })
const mounted = await page.evaluate(() =>
  (document.querySelector('#health-tool-root')?.children.length ?? 0) > 0)
await browser.close()
if (!mounted) { console.error('Widget did not mount on Pages'); process.exit(1) }
if (errors.length) { console.error('Page errors:', errors); process.exit(1) }
console.log('Pages smoke OK — widget mounted, no page errors.')
