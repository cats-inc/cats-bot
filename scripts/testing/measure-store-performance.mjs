#!/usr/bin/env node
/**
 * SPEC-014's performance targets on made-up data (PLAN-014 task 1.7): appending an entry,
 * reading the newest 50, and searches over about a million entries: two-character Chinese
 * words found in few, some and most entries, one character, and two common words together,
 * each over every conversation, the largest and a small one. The 100 ms target is
 * SPEC-014's for a two-character query; the other searches are measured against it too.
 *
 * Usage:
 *   node scripts/testing/measure-store-performance.mjs [--entries <n>] [--json]
 *   ELECTRON_RUN_AS_NODE=1 <electron> scripts/testing/measure-store-performance.mjs ...
 *
 * The database is made in a new temporary directory and removed afterwards. Nothing of the
 * user's is read. It prints the medians of five runs; with --json, one JSON object.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGETS = { appendP95Ms: 5, newest50Ms: 20, twoCharacterQueryMs: 100 };

export function parseArguments(argv) {
  const options = { entries: 1_000_000, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--entries') {
      const value = Number(argv[(index += 1)]);
      if (!Number.isSafeInteger(value) || value < 100)
        throw new Error('--entries takes a whole number of at least 100');
      options.entries = value;
    } else throw new Error(`Unknown argument ${argument}`);
  }
  return options;
}

/** Text with words of known frequencies: 今天 in most entries, 公園 in some, 牙醫 in few. */
function makeText(random, n) {
  const common = ['今天', '我們', '可以', '時間', '問題', '工作', 'the', 'and', 'this', 'that'];
  const middling = ['公園', 'kettle', '電影', 'meeting', '天氣'];
  const rare = ['牙醫', 'zeppelin', '櫻桃樹', 'xylophone'];
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = [];
  const length = 4 + Math.floor(random() * 20);
  for (let i = 0; i < length; i += 1) {
    const r = random();
    words.push(
      r < 0.7
        ? pick(common)
        : r < 0.995
          ? random() < 0.25
            ? pick(middling)
            : `w${Math.floor(random() * 50000)}`
          : pick(rare),
    );
  }
  return `${words.join(random() < 0.5 ? '' : ' ')} ${n}`;
}

export async function measure(options, repositoryRoot = resolve(import.meta.dirname, '../..')) {
  const { openBotStateStore } = await import(
    pathToFileURL(join(repositoryRoot, 'src/core/store/stateStore.ts')).href
  );
  const directory = mkdtempSync(join(tmpdir(), 'cats-bot-store-performance-'));
  let seed = 7;
  // `Math.imul` keeps the product in 32 bits; a plain product loses its low bits past 2^53,
  // and the sequence then repeats after about ten thousand numbers.
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const at = '2026-11-11T08:00:00.000Z';
  try {
    const store = openBotStateStore({ file: join(directory, 'bot.db'), mode: 'writer' });
    // One conversation of 60% of the entries, nineteen of 2% each.
    const big = Math.floor(options.entries * 0.6);
    const conversations = [
      ['big', big],
      ...Array.from({ length: 19 }, (_, i) => [
        `note-${i}`,
        Math.floor((options.entries - big) / 19),
      ]),
    ];
    const madeAt = performance.now();
    for (const [id, count] of conversations) {
      store.saveConversation({
        schemaVersion: 1,
        id,
        role: id === 'big' ? 'home' : 'note',
        title: id,
        createdAt: at,
        updatedAt: at,
      });
      for (let start = 1; start <= count; start += 5000) {
        const batch = [];
        for (let seq = start; seq < Math.min(start + 5000, count + 1); seq += 1) {
          batch.push({
            seq,
            at,
            kind: seq % 2 ? 'owner' : 'bot',
            origin: 'owner',
            text: makeText(random, seq),
          });
        }
        store.importEntries(id, batch);
      }
    }
    const madeSeconds = (performance.now() - madeAt) / 1000;
    const timed = (work, runs = 5) => {
      const times = [];
      let result;
      for (let i = 0; i < runs; i += 1) {
        const started = performance.now();
        result = work();
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return {
        ms: times[Math.floor(times.length / 2)],
        p95: times[Math.ceil(times.length * 0.95) - 1],
        result,
      };
    };
    const append = timed(
      () =>
        store.appendEntry('note-0', {
          at,
          kind: 'owner',
          origin: 'owner',
          text: makeText(random, 0),
        }).seq,
      200,
    );
    const newest = timed(() => store.entriesPage('big', { limit: 50 }).length);
    const searches = {};
    for (const [query, label] of [
      ['牙醫', 'rare'],
      ['公園', 'some'],
      ['今天', 'most'],
      ['天', 'one character'],
      ['今天 我們', 'two common words'],
    ]) {
      for (const scope of [undefined, 'big', 'note-3']) {
        searches[`${label} ${query} in ${scope ?? 'all'}`] = timed(
          () =>
            store.search(query, { limit: 20, ...(scope ? { conversationId: scope } : {}) }).length,
        ).ms;
      }
    }
    store.close();
    return {
      runtime: {
        node: process.versions.node,
        sqlite: process.versions.sqlite,
        electron: process.versions.electron ?? null,
        platform: process.platform,
      },
      entries: options.entries,
      madeSeconds: Number(madeSeconds.toFixed(1)),
      appendP95Ms: Number(append.p95.toFixed(2)),
      newest50Ms: Number(newest.ms.toFixed(2)),
      searchesMs: Object.fromEntries(
        Object.entries(searches).map(([key, ms]) => [key, Number(ms.toFixed(1))]),
      ),
      targets: TARGETS,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const options = parseArguments(process.argv.slice(2));
  const result = await measure(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const { runtime } = result;
    process.stdout.write(
      `${runtime.platform}, Node.js ${runtime.node}, SQLite ${runtime.sqlite}${runtime.electron ? `, Electron ${runtime.electron}` : ''}: ${result.entries} entries made in ${result.madeSeconds} s\n`,
    );
    process.stdout.write(
      `append p95 ${result.appendP95Ms} ms (target ${TARGETS.appendP95Ms}); newest 50 ${result.newest50Ms} ms (target ${TARGETS.newest50Ms})\n`,
    );
    for (const [label, ms] of Object.entries(result.searchesMs)) {
      process.stdout.write(
        `${label.padEnd(36)} ${String(ms).padStart(8)} ms (target ${TARGETS.twoCharacterQueryMs})\n`,
      );
    }
  }
}
