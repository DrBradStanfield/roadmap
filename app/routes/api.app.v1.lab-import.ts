/** POST /api/app/v1/lab-import: one file's extraction for the iPhone app behind App Attest (US-52 AC7; app-routes.server.ts). */
import { appLabImport, postOnly } from '../lib/app-routes.server';

export const loader = () => postOnly();
export const action = ({ request }: { request: Request }) => appLabImport(request);
