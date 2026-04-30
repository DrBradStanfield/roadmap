import { isbot } from 'isbot';

export function isBotUA(ua: string | null): boolean {
  return isbot(ua ?? '');
}
