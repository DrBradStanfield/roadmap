/** How long the browser polls a batch before it gives up. Its own module,
 *  outside the Pages build's swap of upload-api.ts, so upload-pipeline.ts and
 *  the server's join rule (JOIN_LIFE_MS, US-12 AC25, pinned by a test) read one number. */
export const BATCH_POLL_DEADLINE_MS = 10 * 60_000;
