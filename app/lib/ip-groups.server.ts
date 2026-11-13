/**
 * `parseIpv6`: an IPv6 address as its eight 16-bit groups, or null when it is not one
 * (an embedded dotted IPv4 tail included). Shared by the MCP client's
 * public-address check and the per-IP bucket (US-52 AC4g).
 */
function ipv4Groups(dotted: string): [number, number] | null {
  const parts = dotted.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]];
}

export function parseIpv6(address: string): number[] | null {
  const ip = address.toLowerCase();
  if (ip.includes('%') || ip.includes('/')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const bits = side.split(':');
    const groups: number[] = [];
    for (let i = 0; i < bits.length; i++) {
      const bit = bits[i];
      if (bit.includes('.')) {
        if (i !== bits.length - 1) return null;
        const pair = ipv4Groups(bit);
        if (!pair) return null;
        groups.push(pair[0], pair[1]);
      } else if (!/^[0-9a-f]{1,4}$/.test(bit)) {
        return null;
      } else {
        groups.push(parseInt(bit, 16));
      }
    }
    return groups;
  };
  const head = parseSide(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseSide(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}
