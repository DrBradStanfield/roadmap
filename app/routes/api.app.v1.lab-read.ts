/** POST /api/app/v1/lab-read: one file's extraction for the iPhone app behind App Attest, streamed once the counter is spent (US-52 AC7e; app-lab-read.server.ts). */
import { postOnly } from '../lib/app-routes.server';
import { appLabRead } from '../lib/app-lab-read.server';

export const loader = () => postOnly();
export const action = ({ request }: { request: Request }) => appLabRead(request);
