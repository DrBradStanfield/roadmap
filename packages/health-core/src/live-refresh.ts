/**
 * How an open page keeps up with a record something else is writing (US-34),
 * shared by the web widget and the iPhone app (ios/architecture.md D4). The
 * client tells it when the page shows (`visible`) and hides (`hidden`); the
 * store's own change signal (`host.watch`) tells it when something changed.
 * No DOM and no Node: engine-portability.test.ts checks.
 *
 * The provider's change signal where there is one, plus the moments a user
 * comes back to the page. A store with no signal keeps the minute poll; one
 * with a signal does not need it, and paying for it anyway would be a round
 * trip a second apart from a push that already happened. A hidden page
 * watches and polls nothing — it has no screen to keep up to date, and a
 * phone left on a background page would spend the day holding a connection
 * open. Its return catches up on what it missed. The device tier's signal
 * holds no connection, so a hidden page keeps it and reads nothing; its
 * return re-reads only when the stored revision moved since this page last
 * read or wrote it, so a lone page never re-reads at all.
 */
import type { RecordHost } from './record-host';
import { REMOTE_POLL_MS, REMOTE_THROTTLE_MS, type RecordSession } from './record-session';
import { ROADMAP_FILE_NAME } from './adapter';

export interface LiveRefreshOptions {
  /** Re-read the record and merge it in (the store's refreshFromRemote). */
  reread(): Promise<unknown>;
  /** Whether the page is on screen now. Asked at each decision, never cached. */
  isVisible(): boolean;
}

export class LiveRefresh {
  private stopWatch: (() => void) | null = null;
  /** The push a throttled window swallowed. A watch fires once per remote
   *  change and then goes quiet — the cursor has moved past it — so dropping
   *  one on the throttle would lose that change until the user next came
   *  back. It waits out the window instead. */
  private trailing: unknown = null;
  /** When the page last hid. A re-read before then cannot have seen what the
   *  hidden page missed. */
  private hiddenAt = 0;
  private poll: unknown = null;
  private running = false;

  constructor(
    private readonly session: RecordSession,
    private readonly host: RecordHost,
    private readonly opts: LiveRefreshOptions,
  ) {}

  /** Begin: the poll for a store with no change signal, and the signal itself
   *  (on the device tier even while hidden, as it holds no connection). */
  start(): void {
    this.running = true;
    if (!this.host.watch) this.schedulePoll();
    if (this.host.tier === 'device' || this.opts.isVisible()) this.startWatch();
  }

  stop(): void {
    this.running = false;
    if (this.poll !== null) this.host.timers.clear(this.poll);
    this.poll = null;
    this.clearTrailing();
    this.stopWatch?.();
    this.stopWatch = null;
  }

  /** The page shows again, or is still showing (a poll tick, a focus). */
  visible(): void {
    this.startWatch();
    const sync = this.host.sync;
    if (sync && sync.revision(ROADMAP_FILE_NAME) === this.session.seenRevision) return;
    // The return's catch-up waits out the throttle; it is never dropped. Once
    // it has read, a second trigger may be (two return signals fire together).
    if (this.session.lastRefreshAt <= this.hiddenAt) this.pushed();
    else this.reread();
  }

  /** The page went off screen. */
  hidden(): void {
    if (this.host.tier !== 'device') {
      this.stopWatch?.();
      this.stopWatch = null;
    }
    // No read while hidden, a queued one included: it would move the
    // throttle on, and the return's catch-up would be dropped (US-34 AC6).
    this.clearTrailing();
    this.hiddenAt = this.host.clock.now();
  }

  /** The store says the record changed. */
  pushed(): void {
    if (!this.opts.isVisible() || this.trailing !== null) return;
    const wait = REMOTE_THROTTLE_MS - (this.host.clock.now() - this.session.lastRefreshAt);
    if (wait <= 0) {
      this.reread();
      return;
    }
    this.trailing = this.host.timers.set(() => {
      this.trailing = null;
      this.reread();
    }, wait);
  }

  /** A failed re-read is not the user's problem and not a lost write: the
   *  next trigger tries again, and nothing here is waiting on the answer. */
  private reread(): void {
    void this.opts.reread().catch(() => {});
  }

  private startWatch(): void {
    if (!this.host.watch || this.stopWatch) return;
    this.stopWatch = this.host.watch(() => this.pushed());
  }

  private clearTrailing(): void {
    if (this.trailing !== null) this.host.timers.clear(this.trailing);
    this.trailing = null;
  }

  /** The minute poll, one timer at a time: a tick asks where the page is. */
  private schedulePoll(): void {
    this.poll = this.host.timers.set(() => {
      this.poll = null;
      if (this.opts.isVisible()) this.visible();
      else this.hidden();
      if (this.running) this.schedulePoll();
    }, REMOTE_POLL_MS);
  }
}
