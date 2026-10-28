# Anthropic spend report

Each month, which API key and which model spent money on Brad's Anthropic org.

`tools/anthropic-spend.mjs` reads the Anthropic Usage and Cost Admin API. No model runs. No dependencies.

## What it reports

- **Cost rows** (from the cost report): USD per model, token type and cost type, summed over the month. Amounts arrive in cents and are converted.
- **Usage rows** (from the usage report): tokens per API key name and model. USD is blank on these rows: the usage report has no prices, and the script hardcodes none. The cost report cannot group by key, so tying dollars to a key means reading the two together.
- Console playground usage has no key id and shows as `console/playground`. A key id the key list does not know shows as the id.
- A short Markdown summary on stdout: month total, top models by cost, top keys by tokens. `--compare` adds the previous month's total and the % change.

Output: `docs/ops/anthropic-spend/<YYYY-MM>.csv` with columns `month,kind,api_key,model,token_type,cost_type,usd,tokens`.

## The key

It needs an Admin API key (`sk-ant-admin...`), created by an org admin in the Console.

An admin key can create API keys and manage members. Store it in one place only:

- GitHub Actions secret `ANTHROPIC_ADMIN_KEY`.
- Never in the cloud environment, Fly, or `.env`.

The script prints only the HTTP status and Anthropic's `error.type`. It never prints key material.

## Run it locally

```bash
ANTHROPIC_ADMIN_KEY=... node tools/anthropic-spend.mjs --month 2026-09 --compare
```

- `--month YYYY-MM`: default is the current UTC month so far.
- `--out <path>`: default `docs/ops/anthropic-spend/<month>.csv`.
- `--compare`: add the previous month.

Exit codes: 0 ok, 1 API or argument error, 2 missing key.

## Workflow (Brad adds this file)

Save as `.github/workflows/anthropic-spend.yml`. Agents may not edit workflows.

```yaml
name: Anthropic spend

on:
  schedule:
    - cron: '17 18 1 * *'
  workflow_dispatch:
    inputs:
      month:
        description: 'YYYY-MM (blank = last month)'
        required: false

permissions:
  contents: write

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: Report last month
        env:
          ANTHROPIC_ADMIN_KEY: ${{ secrets.ANTHROPIC_ADMIN_KEY }}
          INPUT_MONTH: ${{ inputs.month }}
        run: |
          set -euo pipefail
          month="${INPUT_MONTH:-$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)}"
          [[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]] || { echo "bad month"; exit 1; }
          node tools/anthropic-spend.mjs --month "$month" --compare | tee -a "$GITHUB_STEP_SUMMARY"
          echo "MONTH=$month" >> "$GITHUB_ENV"
      - name: Commit CSV
        run: |
          git config user.name "Brad Stanfield"
          git config user.email "95190896+DrBradStanfield@users.noreply.github.com"
          git add docs/ops/anthropic-spend/
          git diff --cached --quiet && exit 0
          git commit -m "Anthropic spend report $MONTH"
          git pull --ff-only
          git push
```

The `date -d` form works on ubuntu-latest (GNU date). The job skips the commit when the CSV is unchanged.
