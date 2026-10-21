/** POST /api/app/v1/chat: the iPhone app's chat turn behind App Attest (US-52 AC5; app-routes.server.ts). */
import { appChat, postOnly } from '../lib/app-routes.server';

export const loader = () => postOnly();
export const action = ({ request }: { request: Request }) => appChat(request);
