/** Rules split out of knowledge-batch-check.ts (file-size ratchet, US-64 AC23): the topic-master view shape (US-50 AC1)
 *  and the batch exceptions file (US-42 AC11). */

export const EVIDENCE_OPENING = "Brad has not made a video on this topic; this is a summary of the evidence, not his view.";
/** A Current view may hold ONE uncited scope sentence saying what Brad's source does not cover (Brad 2026-11-10, rulings B5
 *  and B8: "The video discusses ordinary honey; Brad has not spoken about manuka specifically."). A fixed shape, so it can
 *  carry no advice: an optional "<The|Brad's> <video|post> <discusses|is about> <1-2 words>; ", then "<Brad|he> has not
 *  spoken about <topic>" with an optional " specifically" or " itself". The topic, hyphenated, must start the handle. */
export const SCOPE_SENTENCE = /^(?:(?:The|Brad's) (?:video|post) (?:discusses|is about) [a-z]+(?: [a-z]+)?; )?(?:Brad|[Hh]e) has not spoken about ([a-z]+(?: (?!specifically\.|itself\.)[a-z]+)?)(?: specifically| itself)?\.$/;
export const isScope = (sn: string, handle: string) => { const t = SCOPE_SENTENCE.exec(sn)?.[1]; const h = t?.replace(/ /g, "-"); return !!h && (handle === h || handle.startsWith(`${h}-`)); };

const EXCEPTION_CHECKS = ["AC2", "AC4", "AC7"];
export function validateExceptions(x: unknown): string[] {
  if (!Array.isArray(x)) return ["exceptions file must be a JSON array"];
  const e: string[] = [];
  x.forEach((v, i) => {
    const r = (v ?? {}) as Record<string, unknown>;
    if (!EXCEPTION_CHECKS.includes(r.check as string)) e.push(`[${i}].check must be one of ${EXCEPTION_CHECKS.join("|")}`);
    for (const k of ["handle", "match", "reason", "date"]) if (typeof r[k] !== "string" || !(r[k] as string).trim()) e.push(`[${i}].${k} must be a non-empty string`);
    if (r.by !== "orchestrator" && r.by !== "Brad") e.push(`[${i}].by must be "orchestrator" or "Brad"`);
  });
  return e;
}
