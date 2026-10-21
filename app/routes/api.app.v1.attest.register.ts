/** POST /api/app/v1/attest/register: stores an App Attest key once Apple's attestation checks out (US-52 AC1; app-routes.server.ts). */
import { appRegister, postOnly } from '../lib/app-routes.server';

export const loader = () => postOnly();
export const action = ({ request }: { request: Request }) => appRegister(request);
