import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { agentTaskListLimit, isTaskActive, isTaskSnapshot, type AgentTaskCreate, type AgentTaskError, type AgentTaskSnapshot } from '../../../../packages/contracts/src/agent-tasks.ts';
import { PrivateDirectory, sameFile } from '../models/private-directory.ts';

const name = 'agent-tasks.sqlite';
const appID = 0x41445041;
const table = `CREATE TABLE tasks (seq INTEGER PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, pet_id TEXT NOT NULL, route_fingerprint TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL CHECK(length(CAST(snapshot AS BLOB)) <= 75000)) STRICT`;
const index = `CREATE INDEX tasks_pet ON tasks(pet_id, seq DESC)`;
const active = `status IN ('queued','running')`;
export class TaskError extends Error { constructor(readonly code: AgentTaskError) { super(code); } }
const unavailable = () => new TaskError('unavailable');
type Patch = Pick<AgentTaskSnapshot, 'phase' | 'status' | 'progress' | 'result' | 'error'>;
function decode(row: Record<string, SQLOutputValue>): AgentTaskSnapshot {
 const value: unknown = typeof row.snapshot === 'string' && JSON.parse(row.snapshot);
 if (!isTaskSnapshot(value) || value.taskID !== row.task_id || value.petID !== row.pet_id || value.status !== row.status) throw unavailable();
 return value;
}

/** Single app-service owner; serializes short commits, with no async work inside a SQLite transaction. */
export class AgentTaskStore {
 private readonly directory: PrivateDirectory;
 private db?: DatabaseSync;
 private identity?: Stats;
 private tail: Promise<unknown> = Promise.resolve();
 private closing?: Promise<void>;
 constructor(root: string) { this.directory = new PrivateDirectory(root, false); }
 private async open() {
  let file = await this.directory.file(name);
  if (!file && !this.identity) {
   const handle = await this.directory.create(name);
   try { await handle.sync(); file = await handle.stat(); } finally { await handle.close(); }
   await this.directory.sync();
  }
  if (!file || this.identity && !sameFile(this.identity, file)) throw unavailable();
  await this.directory.file(`${name}-journal`);
  if (await this.directory.file(`${name}-wal`) || await this.directory.file(`${name}-shm`)) throw unavailable();
  if (this.db) return this.db;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(this.directory.path(name), { timeout: 0, allowExtension: false });
  try {
   const opened = await this.directory.file(name);
   if (!opened || !sameFile(file, opened)) throw unavailable();
   db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON');
   if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw unavailable();
   const version = db.prepare('PRAGMA user_version').get()?.user_version, id = db.prepare('PRAGMA application_id').get()?.application_id;
   const schema = () => db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all().map(row => row.sql);
   if (version === 0 && id === 0 && schema().length === 0) db.exec(`BEGIN IMMEDIATE; ${table}; ${index}; PRAGMA application_id=${appID}; PRAGMA user_version=1; COMMIT`);
   else if (version !== 1 || id !== appID) throw unavailable();
   const actual = schema();
   if (actual.length !== 2 || !actual.includes(table) || !actual.includes(index)) throw unavailable();
   db.exec('PRAGMA max_page_count=32768');
   this.transaction(db, () => {
    for (const row of db.prepare(`SELECT task_id, pet_id, status, snapshot FROM tasks WHERE ${active} LIMIT 4`).all()) {
     const task = decode(row);
     this.write(db, { ...task, status: 'outcome-unknown', revision: task.revision + 1 });
    }
   });
   this.identity = opened; this.db = db;
   return db;
  } catch (err) { db.close(); throw err; }
 }
 private run<T>(action: (db: DatabaseSync) => T): Promise<T> {
  if (this.closing) return Promise.reject(unavailable());
  const next = this.tail.then(async () => action(await this.open()));
  this.tail = next.catch(() => {});
  return next;
 }
 private transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
 }
 private write(db: DatabaseSync, task: AgentTaskSnapshot) {
  if (!isTaskSnapshot(task)) throw new TaskError('invalid_request');
  db.prepare('UPDATE tasks SET status=?, snapshot=? WHERE pet_id=? AND task_id=?').run(task.status, JSON.stringify(task), task.petID, task.taskID);
  return task;
 }
 create({ taskID, petID, route }: Pick<AgentTaskCreate, 'taskID' | 'petID' | 'route'>) {
  return this.run(db => this.transaction(db, () => {
   if (db.prepare('SELECT 1 FROM tasks WHERE task_id=?').get(taskID)) throw new TaskError('conflict');
   if (db.prepare(`SELECT 1 FROM tasks WHERE pet_id=? AND ${active}`).get(petID) ||
    Number(db.prepare(`SELECT count(*) AS n FROM tasks WHERE ${active}`).get()?.n) >= 3) throw new TaskError('busy');
   if (Number(db.prepare('SELECT count(*) AS n FROM tasks').get()?.n) >= 2000) throw new TaskError('limit');
   const task = { petID, taskID, attemptID: randomUUID(), revision: 1, status: 'queued', phase: 'admitting', progress: 0 } as const;
   if (!isTaskSnapshot(task) || !/^[a-f0-9]{64}$/.test(route.fingerprint)) throw new TaskError('invalid_request');
   db.prepare('INSERT INTO tasks(task_id, pet_id, route_fingerprint, status, snapshot) VALUES (?, ?, ?, ?, ?)').run(taskID, petID, route.fingerprint, task.status, JSON.stringify(task));
   return task;
  }));
 }
 list(petID: string) {
  return this.run(db => db.prepare(`SELECT task_id, pet_id, status, snapshot FROM tasks WHERE pet_id=? ORDER BY ${active} DESC, seq DESC LIMIT ?`).all(petID, agentTaskListLimit).map(decode));
 }
 read(petID: string, taskID: string) { return this.run(db => this.lookup(db, petID, taskID)); }
 private lookup(db: DatabaseSync, petID: string, taskID: string) {
  const row = db.prepare('SELECT task_id, pet_id, status, snapshot FROM tasks WHERE pet_id=? AND task_id=?').get(petID, taskID);
  return row && decode(row);
 }
 transition(expected: Pick<AgentTaskSnapshot, 'petID' | 'taskID' | 'attemptID' | 'revision'>, patch: Patch) {
  return this.run(db => this.transaction(db, () => {
   const task = this.lookup(db, expected.petID, expected.taskID);
   if (!task || !isTaskActive(task.status) || task.attemptID !== expected.attemptID || task.revision !== expected.revision ||
    patch.progress < task.progress || patch.status === 'queued' || task.status === 'queued' && patch.status === 'completed') throw new TaskError('conflict');
   const { phase, status, progress, result, error } = patch;
   return this.write(db, { ...task, phase, status, progress, revision: task.revision + 1, ...(result !== undefined && { result }), ...(error !== undefined && { error }) });
  }));
 }
 close() { return this.closing ??= this.tail.then(() => this.db?.close()); }
}
