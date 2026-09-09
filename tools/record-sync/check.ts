/** Run with node --import tsx tools/record-sync/check.ts. Synthetic, no network. */
import { encode, emptyCheckpoint } from './model';
import { MemoryJournal } from './memory-storage';
import { compact, readView, submit } from './protocol';
import { scheduleModel } from './schedules';
import { transaction } from './fixtures';

const storage = new MemoryJournal(emptyCheckpoint());
await submit(storage, 'object', encode(transaction('example')));
await compact(storage);
const result = {
  modelOnly: true,
  unconditional: scheduleModel(false), conditional: scheduleModel(true),
  quiescent: { checkpoints: storage.current ? 1 : 0, temporaryObjects: storage.objects.size, receipts: (await readView(storage)).entries.length },
  productionCleanupEnabled: false,
};
console.log(JSON.stringify(result, null, 2));
if (result.unconditional.schedules !== 35 || result.unconditional.losses !== 4
  || result.conditional.schedules !== 35 || result.conditional.losses !== 0
  || result.quiescent.checkpoints !== 1 || result.quiescent.temporaryObjects !== 0 || result.quiescent.receipts !== 1) {
  process.exitCode = 1;
}
