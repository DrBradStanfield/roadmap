/** The plan's bounded counterexample: four ordered steps per compactor. */
export function scheduleModel(conditional: boolean): { schedules: number; losses: number } {
  const schedules: number[][] = [];
  function visit(path: number[], a: number, b: number): void {
    if (a === 4 && b === 4) { schedules.push(path); return; }
    if (a < 4) visit([...path, 0], a + 1, b);
    if (b < 4 && a > 0) visit([...path, 1], a, b + 1);
  }
  visit([], 0, 0);
  let losses = 0;
  for (const schedule of schedules) {
    let checkpoint = new Set<string>();
    let revision = 0;
    const pending = new Set(['a']);
    const admitted = new Set(['a']);
    const writers = [0, 1].map(() => ({ step: 0, revision: 0, captured: new Set<string>(), candidate: new Set<string>(), published: false, verified: false }));
    let lost = false;
    for (const index of schedule) {
      const writer = writers[index];
      switch (writer.step++) {
        case 0:
          if (index === 1) { pending.add('b'); admitted.add('b'); }
          writer.revision = revision;
          writer.captured = new Set(pending);
          writer.candidate = new Set([...checkpoint, ...pending]);
          break;
        case 1:
          if (!conditional || revision === writer.revision) {
            checkpoint = new Set(writer.candidate); revision++; writer.published = true;
          }
          break;
        case 2:
          writer.verified = writer.published && [...writer.captured].every(id => checkpoint.has(id));
          break;
        case 3:
          if (writer.verified) for (const id of writer.captured) pending.delete(id);
      }
      if ([...admitted].some(id => !checkpoint.has(id) && !pending.has(id))) lost = true;
    }
    if (lost) losses++;
  }
  return { schedules: schedules.length, losses };
}
