// A writer that is killed mid-transaction: it commits three rows to a WAL database, opens a
// transaction it never commits, says so and waits. Usage: node sqlite-crash-writer.mjs <database file>
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const database = new DatabaseSync(process.argv[2]);
database.exec('pragma journal_mode=wal; pragma synchronous=normal');
database.exec('create table notes(id integer primary key, body text not null) strict');
const insert = database.prepare('insert into notes(body) values (?)');
for (const body of ['one', 'two', 'three']) insert.run(body);
database.exec('begin');
insert.run('never committed');
process.stdout.write('ready\n');
setInterval(() => undefined, 60_000);
