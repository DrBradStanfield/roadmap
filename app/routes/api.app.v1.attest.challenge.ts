/** POST /api/app/v1/attest/challenge: a fresh App Attest challenge for the iPhone app (US-52 AC1; app-routes.server.ts). */
import { appChallenge, postOnly } from '../lib/app-routes.server';

export const loader = () => postOnly();
export const action = ({ request }: { request: Request }) => appChallenge(request);
