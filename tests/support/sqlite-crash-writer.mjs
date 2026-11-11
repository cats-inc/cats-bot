// A writer that is killed mid-transaction. It commits three rows to a WAL database, then opens
// a transaction it never commits and makes it large enough, with a page cache small enough,
// that its pages are already in the write-ahead log on disk. It says so and waits.
// Usage: node sqlite-crash-writer.mjs <database file>
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const database = new DatabaseSync(process.argv[2]);
database.exec('pragma journal_mode=wal; pragma synchronous=normal; pragma cache_size=8');
database.exec('create table notes(id integer primary key, body text not null) strict');
const insert = database.prepare('insert into notes(body) values (?)');
for (const body of ['one', 'two', 'three']) insert.run(body);
database.exec('begin');
for (let index = 0; index < 400; index += 1) insert.run(`never committed ${index} ${'x'.repeat(2000)}`);
process.stdout.write('ready\n');
// The test kills this process; the timer only keeps an abandoned one from living on.
setTimeout(() => process.exit(1), 60_000);
