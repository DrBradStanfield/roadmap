# Build 13: what it would carry (draft for Fable, 2026-11-13)

Since build 12 (f40c8af8), main has merged these iPhone changes:
- Privacy and data safety: the N1 root fix (1599: an erase whose draw fails no longer leaves the pre-erase record readable), the phone-erase epoch guards (1524, 1540), the erase and redraw fixes (1595), and the reminders erase-epoch rules (1594, 1597, 1608).
- Typed state: the onboarding union (1512, 1570), the first-run Cover and Offer unions (1602, with S41/S42 in 1608), the metric-read union (1548) and the reminders mode (1594).
- The generated I-2 bridge contract, with Zod doors, guardedEdit and target-neutral editSession (1519, 1534, 1558, 1578). Bridge id is unchanged at 40fc97db4ca12547.
- Engine moves (1631, 1633, 1632, 1634, 1635), the M19 first-seen due date (1538), the PSA screening interval (1387, clinical; already live on web) and engine release 202611130818.
Also merged: S46 (1641: a finished erase always reaches the record store, privacy) and the test.sh fixes (1621, 1637, tooling only). Pending and likely in: the S41 refresh-before-draw fix (1640), then lead S49 (a privacy fix in the erase reply path). I-6's `numberQuestionJson` door would change the bridge, so it goes in only if build 13 waits for it.

Before an archive: one full two-zone suite on the final tip. 47663d15 passed: 985 run, 0 failures. The batch-end Verify list then needs a simulator pass, since unit tests can't reach these:
- the AC7 first-run UI test;
- Back up opens Sync, with one analytics event per close;
- a remote erase while the backup prompt or Sync sheet is up (S48);
- tapping reminders while a cloud is opening;
- a remote erase during the permission ask;
- a cloud erase whose draw fails, checking that My data, chat, export and reminders show only the erased record.
