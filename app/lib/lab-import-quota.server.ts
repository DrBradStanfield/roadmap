/**
 * The per-machine daily file cap — the dollar ceiling on extraction (US-35
 * AC10). Two callers spend from it: the website's upload route
 * (`api.lab-import-v2.ts`) and the connector's `import_documents`, so the
 * ceiling stays ONE number. In-memory, so the true cap is
 * `AI_DAILY_FILE_CAP × machines × 2 apps` and it resets on deploy — an
 * accepted approximation until a shared counter is worth its DDL.
 */
const MACHINE_DAILY_CAP = Number(process.env.AI_DAILY_FILE_CAP || 500);

let machineDay = '';
let machineCount = 0;

/** Consume `count` files against the machine cap; false (and nothing consumed) past it. */
export function consumeMachineFiles(count: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (machineDay !== today) {
    machineDay = today;
    machineCount = 0;
  }
  if (machineCount + count > MACHINE_DAILY_CAP) return false;
  machineCount += count;
  return true;
}

/** Test seam — the counter is process-global. */
export function resetMachineFiles(): void {
  machineDay = '';
  machineCount = 0;
}
