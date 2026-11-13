# C27 and C28: the picker's move and the reconnect (design note)

## Today

One page-life union, `SwitchFlow` (widget-src/standalone/switch-flow.ts:32-39): `idle`, `switching`,
`loggingOff`, `navigating`, `reconnecting`, `reconnected`. Events :41-52. `dispatch` (:103) is the
synchronous claim: only `idle` accepts `start`, `logOff` or `reconnect` (:64-69). A move that hands the
page to a redirect or reload ends in `navigating` (`settled`, :81, or `navigating()`, :126). Only two
events leave `navigating`: `restored` (a back-forward cache page show, :133-137) and `reopened` (the
picker mounting, widget-src/standalone/backend-picker.tsx:135-136). A `failed` for its run also does (:75).

## C28: a reload that does not happen locks the picker

Sequence: from a self-hosted record, open the picker, choose Dropbox (backend-picker.tsx:158).
`navigating()` (:169), then `connect()` calls `location.assign`. The person stops the load (Esc, the
Stop button) before Dropbox answers. The page stays. `settled` is refused (switch-flow.ts:76), so the
flow stays `navigating`; the picker's `busy` (backend-picker.tsx:140) disables every choice and Log off.
The same holds after every hand-off: a local move (:162), a GitHub or WebDAV connect (finishFormConnect's
reload), a log-off, the Drive reconnect (sync-control.tsx:186-187) and "Use this browser only" (:266).
The reconnect panel's buttons (sync-control.tsx:214, :295, :312, :316) lock too, and they have no exit
of their own: only opening the picker frees them. picker-one-move.test.tsx:356 pins the lock as a control.

beforeunload: no handler in the app cancels the unload (page-departure.ts:11, HealthTool.tsx:332,
chat-sync.ts:34 only flush or close). A stopped load sends the old document no event at all: no
pageshow, no pagehide; the Navigation API's navigateerror covers only same-document navigations.
So nothing in the page can know. A timer is the only signal.

Change: `useSwitchFlow` runs one effect keyed on (`navigating`, run). After `HAND_OFF_MS` (15 s) it
dispatches `{ type: 'stayed', run }`; any change of state clears it. `stayed` ends `navigating` at its
own run, as `reopened` does; at any other run or state it changes nothing. A new event, no new state.
Every surface that reads the flow (picker, panel, storage bar) mounts the effect, so each unlocks.
A page that really is leaving dies before 15 s; one still loading after 15 s unlocks, which is what
closing and reopening the picker does today.

## C27: two guards

The lead's premise is stale. `reconnectInFlight` and `useBusyRun` were deleted in 71ce074cf
(PR 1481): the Drive reconnect is `reconnecting`/`reconnected` in the same union. Both paths read
it: the picker's `busy = flow.kind !== 'idle'` (backend-picker.tsx:140), the panel's
`idle = flow.kind === 'idle'` (sync-control.tsx:190), and both start through `runMove`, so the one
claim refuses a second move whichever surface asks. They cannot disagree. Retry (sync-control.tsx:164)
claims nothing, but it is disabled outside `idle`.

Change: no production code. One pin: while a picker move is mid-flight, the panel's Reconnect is
disabled and a click opens no popup (the reverse is reconnect-move.test.tsx:108). A shared helper
for `kind === 'idle'` would add a line to save none.

## Tests (US-09 AC45a)

- switch-flow table: `stayed` and `stayedOld` columns (8 states x 19 events).
- Picker: after a Dropbox hand-off that never leaves, once the delay passes, every choice is enabled
  without closing the picker; before it, still locked.
- Panel: a Drive reconnect whose reload never happens frees Reconnect after the delay, and the picker too.
- C27 pin as above.
