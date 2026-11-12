/**
 * The erase a chat question is asked under (US-11 AC2h): how many erases this
 * page has begun, and the record's erase identity. A reply is saved to chat
 * history only if this has not moved since its question was asked, so an
 * erase begun while the answer is on its way counts from its start, before
 * the record moves, and another device's counts once the record has read it.
 * No runtime imports: chat-api.ts ships in the production widget, which must
 * not bring in the storage stack. roadmap-data.ts registers the reader.
 */
let erasesBegun = 0;
let recordErase = (): string => '';

export function setChatEraseReader(read: () => string): void {
  recordErase = read;
}

/** Called as an erase starts, before any of its steps. */
export function eraseBegan(): void {
  erasesBegun += 1;
}

export function chatAskedUnder(): string {
  return `${erasesBegun}:${recordErase()}`;
}
