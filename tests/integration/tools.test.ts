import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { fixtureCliCommand, fixtureCliLaunchArgs, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-001 A2 against the real pinned cats-runtime: the fixture CLI receives
 * the bot's session MCP server through the runtime's `--mcp-config` and calls
 * it the way Claude Code would (bearer token from the environment variable the
 * runtime sets). A schedule created that way exists, fires on the tick, and
 * its result persists; a question becomes an approval; a heartbeat turn
 * reaches the CLI and a quiet answer leaves no message.
 */

let home: TempHome;
let projectsDir: string;
before(() => {
  home = makeTempHome('cats-bots-tools-');
  projectsDir = join(home.botsHome, 'claude-projects');
  mkdirSync(projectsDir, { recursive: true });
});
after(() => home.cleanup());

test('the fixture CLI schedules through the bot tool server and the schedule fires', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'tools',
    profile: { instructions: 'You are Mochi.' },
    core: {
      turnRetry: { ownerBusyMs: 300, backgroundBusyMs: 300, runtimeUnavailableMs: 300 },
      life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000, random: () => 0 },
      runtime: {
        runtimeEntry: resolveRuntimeEntry(),
        providerCommand: fixtureCliCommand,
        providerLaunchArgs: fixtureCliLaunchArgs,
        instanceExtras: { projects_dir: projectsDir },
        readyTimeoutMs: 90_000,
        stopTimeoutMs: 10_000,
        env: {
          ...process.env,
          HOME: home.botsHome,
          USERPROFILE: home.botsHome,
          APPDATA: join(home.botsHome, 'AppData', 'Roaming'),
          LOCALAPPDATA: join(home.botsHome, 'AppData', 'Local'),
          XDG_CONFIG_HOME: join(home.botsHome, '.config'),
          XDG_DATA_HOME: join(home.botsHome, '.local', 'share'),
        },
      },
    },
  });
  await core.start();
  try {
    const scheduled = await sendAndWait(core, 'home', 'schedule:0.02:say hello from the schedule', 60_000);
    assert.equal(scheduled.state, 'completed', scheduled.error);
    assert.match(scheduled.result?.text ?? '', /scheduled -> Scheduled sch-[0-9a-f]{8} once at/u, 'the CLI reached the tool server');
    const schedules = await core.listSchedules();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]?.createdBy, 'agent');
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'system' && entry.text.includes(schedules[0]!.receipt)));

    const listed = await sendAndWait(core, 'home', 'schedules?', 60_000);
    assert.match(listed.result?.text ?? '', /say hello from the schedule/u);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'schedule', 60_000);
    const report = await core.tick();
    assert.deepEqual(report.firedSchedules, [schedules[0]!.id]);
    const fired = await done;
    assert.equal(fired.type === 'turn.completed' && fired.workItem.state, 'completed');
    assert.equal(fired.type === 'turn.completed' && fired.workItem.result?.text, 'echo: say hello from the schedule');
    assert.equal((await core.listSchedules())[0]?.state, 'completed');

    const asked = await sendAndWait(core, 'home', 'ask:May I clean the downloads folder?', 60_000);
    assert.match(asked.result?.text ?? '', /asked -> Your question was handed to your owner as approval wi-/u);
    const waiting = core.listWorkItems().find((item) => item.state === 'awaiting_owner');
    assert.ok(waiting);
    assert.equal(waiting.prompt, 'May I clean the downloads folder?');
    const decided = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'owner_message' && /Decision/u.test(event.workItem.prompt), 60_000);
    await core.resolveApproval(waiting.id, 'deny');
    const decision = await decided;
    assert.match(decision.type === 'turn.completed' ? decision.workItem.result?.text ?? '' : '', /echo: Decision on your question "May I clean the downloads folder\?": denied/u);

    // A heartbeat turn reaches the real CLI; the owner spoke seconds ago, so pretend it was long ago.
    const home1 = (await core.listConversations())[0]!;
    (core as unknown as { conversations: { update(id: string, fn: (record: { lastOwnerMessageAt: string | null }) => void): void } })
      .conversations.update(home1.id, (record) => {
        record.lastOwnerMessageAt = new Date(Date.now() - 11 * 60_000).toISOString();
      });
    await core.updateProfile({ heartbeat: { enabled: true, wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0 } });
    const beforeHeartbeat = core.transcript('home').length;
    const heartbeat = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'heartbeat', 60_000);
    const queued = await core.tick();
    assert.equal(queued.heartbeat?.action, 'queued', JSON.stringify(queued));
    const beat = await heartbeat;
    assert.equal(beat.type === 'turn.completed' && beat.workItem.state, 'completed');
    assert.equal(core.transcript('home').length, beforeHeartbeat, 'a quiet heartbeat leaves no message');
    assert.ok(beat.type === 'turn.completed' && beat.workItem.result?.text === '', 'the quiet reply was dropped');
  } finally {
    await core.stop();
  }
});
