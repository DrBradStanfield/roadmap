/** How long the browser polls a batch before it gives up. Its own module so
 *  both upload transports (upload-api.ts, and byok-upload.ts in the Pages
 *  build) and the server's join rule (JOIN_LIFE_MS, US-12 AC25) read one number. */
export const BATCH_POLL_DEADLINE_MS = 10 * 60_000;
