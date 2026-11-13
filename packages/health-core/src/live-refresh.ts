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
 *
 * The same moments retry a failed cloud save (US-09 AC30): the page showing
 * again and the device coming back online, at most once a minute per page.
 * The minute poll never retries. The device tier never does: a full or
 * blocked store does not heal when the network comes back.
 */
import type { RecordHost } from './record-host';
import { REMOTE_POLL_MS, REMOTE_THROTTLE_MS, type RecordSession } from './record-session';
import { ROADMAP_FILE_NAME } from './adapter';
import type { SaveRetry } from './save-retry-words';

/** At most one retry of a failed save per this long, per page (US-09 AC30). */
export const SAVE_RETRY_MS = 60_000;

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
  /** When this page's last retry started a pass, on the host clock. */
  private lastRetry = -Infinity;

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

  /** The page shows again, or is still showing (a focus): retry a failed
   *  save, then catch up. A retry that starts a pass makes the re-read stand
   *  aside (writePending). */
  visible(): void {
    this.retryIfDue('focus');
    this.catchUp();
  }

  /** The device is back online: retry a failed save, whatever the page's
   *  visibility; catch up as a return does only while it shows. */
  online(): void {
    this.retryIfDue('online');
    if (this.opts.isVisible()) this.catchUp();
  }

  /** Catch up on what the page missed (a return, or a poll tick). */
  private catchUp(): void {
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

  /** Retry a failed save, on the cloud tier, unless a retry started a pass
   *  in the last minute. Only one that started a pass counts: a session with
   *  nothing owed answers null and holds off nothing. Reports how it ended. */
  private retryIfDue(trigger: SaveRetry['trigger']): void {
    if (this.host.tier !== 'cloud' || this.host.clock.now() - this.lastRetry < SAVE_RETRY_MS) return;
    const run = this.session.retry();
    if (!run) return;
    this.lastRetry = this.host.clock.now();
    void run.then((landed) => this.host.saveRetried?.({ trigger, outcome: landed ? 'landed' : 'failed' })).catch(() => {});
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
      try {
        if (this.opts.isVisible()) this.catchUp(); // never a retry (US-09 AC30)
        else this.hidden();
      } finally {
        // A tick that throws (a host's revision read, say) must not end the poll.
        if (this.running) this.schedulePoll();
      }
    }, REMOTE_POLL_MS);
  }
}
