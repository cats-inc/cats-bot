# Locks left by a restart — 2026-11-08

After a Windows restart, the installed Cats Bot 0.5.4 refused to start:
"Another Cats Bot (…\Cats Bot.exe, pid 2408) manages the cat bots in
%USERPROFILE%\.catsbot." No other Cats Bot ran.

## What happened

- The hub started at sign-in at 21:40:58 (local), 83 seconds after boot, as
  PID 2408, and wrote `hub.lock.json` naming that PID.
- Windows restarted at 22:21:55. `host.log` has no `before-quit`, `will-quit`
  or `quit` line for PID 2408. Electron documents that these events are not
  emitted on Windows when a shutdown, restart or sign-out closes the app, so
  the lock's `release()` never ran.
- After boot at 22:22:06, `svchost.exe` was created as PID 2408 at 22:22:21.
- At sign-in the hub read the lock: same host, and `process.kill(2408, 0)`
  failed with EPERM, which the check counted as alive. The start at sign-in
  and a manual start both showed the dialog.

## Not a new regression

The check (host plus a live PID) dates from the hub's root lock in #66
(`d24ce12`, first released in 0.3.0), and the instance lock had it since #5.
PLAN-009 D24 accepted it then: a lock whose PID belonged to another program
named the file to delete. Every earlier shutdown in `host.log` also left the
lock, and the next start succeeded only because the PID was free. Starting at
sign-in by default (#101) made it likely: a process started soon after boot
gets a low PID, which boot-time services take again on the next boot.

## Same flaw elsewhere

- `bots/<id>/instance.lock.json` still named the core's PID 22552 from before
  the restart. That PID was free, so the core started.
- The update leases `installations/<hash>/pid-20508.json` (2026-11-05) and
  `pid-2408.json` were both left by shutdowns. With PID 2408 in use, the next
  update would have stopped with "Quit the other Cats Bot instances".
- The registry's write lock uses the same check.

## The rule now

A lock or lease records its writer's process identity, and stands only while
the process using its PID has the same one (SPEC-001 FR-3). No clock is read
after a process starts, so a clock step, a sleep or a paused VM cannot make a
live lock look stale; a stale lock wrongly kept costs a dialog, while a live
one wrongly taken lets two cores write one bot.

- Windows: the creation FILETIME, through koffi. `GetProcessTimes` answers in
  about 90 µs for processes of this account. Services refuse the handle
  (`ERROR_ACCESS_DENIED` for PID 2408, 4 and 1324 here), so the system process
  list from `NtQuerySystemInformation` answers for them in 7 to 9 ms for 432
  processes. Its layout is not documented, so it is used only after it agrees
  with `GetProcessTimes` for the reading process. It reported PID 2408 at
  14:22:21.412Z, as CIM did, after the lock's 13:40:58Z.
- Linux: the boot id and field 22 of `/proc/<pid>/stat`, the start time in
  clock ticks since boot.
- macOS: `ps -o lstart=` in UTC, at most every 500 ms per PID.
- An identity that cannot be read leaves a lock with a live PID standing, as
  before, so a system without koffi or `/proc` keeps the old behavior.
- Records from 0.5.4 and earlier have no identity. On Windows they are stale
  when the process using their PID was created more than a minute after them,
  which heals the files a restart left. One naming the reader's own PID is
  stale when written more than a minute before the reader started. Otherwise
  they stand.
- A stale lock is removed only while its bytes are still those judged, so a
  lock another hub wrote in the meantime survives.

A first version compared creation time with the lock's time through a hidden
PowerShell and fell back to the boot time. Review found that a clock step
between a process's start and its lock, or a forward step after it (a paused
VM, a large correction), could make a live lock look stale, and that the query
blocked the hub for a second or more on each read. Identities replaced it.

Releasing the locks when Windows ends the session would leave fewer stale
files, but a power loss or crash still leaves them, so the identity rule is
the fix.
