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

A lock or lease stands only while the process using its PID is the one that
wrote it (SPEC-001 FR-3):

- On Windows the process's creation time comes from CIM through one hidden
  PowerShell, about one to two seconds. It runs only when the PID is alive and
  is not this process, and the result is cached for ten minutes. Both times
  come from the same clock, so a later clock step does not change the answer.
  PID 2408 reported 14:22:21Z, after the lock's 13:40:58Z.
- Elsewhere, or when the query fails, a record more than five minutes older
  than the last boot is stale. libuv's uptime counts sleep on all three
  systems (`GetTickCount64`, `/proc/uptime` or `CLOCK_BOOTTIME`,
  `KERN_BOOTTIME`), so a long sleep does not make a live lock look old.
- Windows Fast Startup keeps the boot time across a shutdown. Only the
  creation time catches a reused PID then, which is why Windows reads it.
- A lock naming this process's own PID stands only if it was written after
  this process started.

Releasing the locks when Windows ends the session would leave fewer stale
files, but a power loss or crash still leaves them, so the start-time rule is
the fix.
