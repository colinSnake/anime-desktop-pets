import type { Stats } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { chatHistoryDetailSize, chatHistoryPageSize, isHistoryDetail, isHistoryInput, isHistoryPage, isHistoryTurn, isChatProject, maxChatProjects, type ChatProject, type ChatHistoryDetail, type ChatHistoryPage, type ChatHistoryTurn } from '../../../packages/contracts/src/chat-history.ts';
import { isChatConversation, type ChatConversation, type ChatExchange } from '../../../packages/contracts/src/online-chat.ts';
import { petId } from '../../../packages/contracts/src/pets.ts';
import { PrivateDirectory, sameFile } from './models/private-directory.ts';
import { safeChatFields } from './characters/chat-context-policy.ts';

const databaseName = 'chats.sqlite';
const applicationID = 0x41445054;
const oldTable = `CREATE TABLE turns (
  seq INTEGER PRIMARY KEY,
  pet_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_text TEXT NOT NULL CHECK(length(CAST(user_text AS BLOB)) BETWEEN 1 AND 12288),
  assistant_text TEXT NOT NULL CHECK(length(CAST(assistant_text AS BLOB)) BETWEEN 1 AND 24576),
  completed_at INTEGER NOT NULL,
  UNIQUE(pet_id, request_id)
) STRICT`;
const oldIndex = 'CREATE INDEX turns_pet_seq ON turns(pet_id, seq DESC)';
const sessions = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  UNIQUE(pet_id, number)
) STRICT`;
const turns = `CREATE TABLE turns (
  seq INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  user_text TEXT NOT NULL CHECK(length(CAST(user_text AS BLOB)) BETWEEN 1 AND 12288),
  assistant_text TEXT NOT NULL CHECK(length(CAST(assistant_text AS BLOB)) BETWEEN 1 AND 24576),
  completed_at INTEGER NOT NULL,
  replayable INTEGER NOT NULL CHECK(replayable IN (0, 1))
) STRICT`;
const sessionsIndex = 'CREATE INDEX sessions_pet_seq ON sessions(pet_id, last_seq DESC)';
const turnsIndex = 'CREATE INDEX turns_session_seq ON turns(session_id, seq DESC)';
const replayIndex = 'CREATE INDEX turns_session_replay ON turns(session_id, seq DESC) WHERE replayable = 1';
const nextSchema = [sessions, turns, sessionsIndex, turnsIndex, replayIndex];
const projectSchema = [`CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  pet_id TEXT NOT NULL,
  name TEXT NOT NULL
) STRICT`, `CREATE TABLE session_projects (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id)
) STRICT`, 'CREATE INDEX projects_pet_id ON projects(pet_id)'];
const projectColumn = '(SELECT project_id FROM session_projects WHERE session_id = s.id)';
const projectOwner = (db: DatabaseSync, petID: string, projectID?: string) =>
  projectID === undefined || !!db.prepare('SELECT id FROM projects WHERE pet_id = ? AND id = ?').get(petID, projectID);
const sessionOwner = (db: DatabaseSync, id: string) =>
  db.prepare(`SELECT pet_id, ${projectColumn} AS projectID FROM sessions s WHERE id = ?`).get(id);
const fields = 'request_id AS requestID, user_text AS user, assistant_text AS assistant, completed_at AS completedAt';
const invalid = () => new Error('chat_history_unavailable');

/** Owns one private database. All mutations are synchronous, short SQLite statements;
 * async permission checks happen before the commit point, never inside a transaction. */
export class ChatHistory {
  private db?: DatabaseSync;
  private identity?: Stats;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly directory: PrivateDirectory;

  constructor(root: string) { this.directory = new PrivateDirectory(root, false); }

  private async database() {
    const file = await this.directory.file(databaseName);
    if (!file || (this.identity && !sameFile(this.identity, file))) throw invalid();
    await this.directory.file(`${databaseName}-journal`);
    // The application never uses WAL. Do not accept segments from a different owner or mode.
    if (await this.directory.file(`${databaseName}-wal`) || await this.directory.file(`${databaseName}-shm`)) throw invalid();
    if (this.db) return this.db;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(this.directory.path(databaseName), { timeout: 0, allowExtension: false });
    try {
      const opened = await this.directory.file(databaseName);
      if (!opened || !sameFile(opened, file)) throw invalid();
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON');
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw invalid();
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      const id = db.prepare('PRAGMA application_id').get()?.application_id;
      const readSchema = () => db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all().map(row => row.sql);
      const matches = (expected: string[]) => {
        const actual = readSchema();
        return actual.length === expected.length && expected.every(sql => actual.includes(sql));
      };
      if ((version === 0 && id === 0 && matches([])) || (version === 1 && id === applicationID && matches([oldTable, oldIndex]))) {
        const reset = version === 1 ? 'DROP TABLE turns;' : '';
        db.exec(`BEGIN IMMEDIATE; ${reset} ${nextSchema.join('; ')}; PRAGMA application_id=${applicationID}; ${projectSchema.join('; ')}; PRAGMA user_version=3; COMMIT`);
      } else if (version === 2 && id === applicationID && matches(nextSchema)) {
        db.exec(`BEGIN IMMEDIATE; ${projectSchema.join('; ')}; PRAGMA user_version=3; COMMIT`);
      } else if (version !== 3 || id !== applicationID) throw invalid();
      if (!matches([...nextSchema, ...projectSchema])) throw invalid();
      db.exec('PRAGMA max_page_count=65536');
      this.identity = file;
      this.db = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private run<T>(operation: (db: DatabaseSync) => T) {
    if (this.closing) return Promise.reject(invalid());
    const work = this.queue.then(async () => operation(await this.database()));
    this.queue = work.catch(() => {});
    return work;
  }
  async append(petID: string, conversation: ChatConversation, turn: ChatHistoryTurn, replayable: boolean, signal?: AbortSignal) {
    if (!petId(petID) || !isChatConversation(conversation) || !isHistoryTurn(turn) || typeof replayable !== 'boolean' || !safeChatFields([turn.user, turn.assistant])) throw invalid();
    signal?.throwIfAborted();
    return this.run(db => {
      signal?.throwIfAborted();
      const { id, mode, projectID } = conversation, { requestID, user, assistant, completedAt } = turn;
      db.exec('BEGIN IMMEDIATE');
      try {
        const owner = sessionOwner(db, id);
        if (!projectOwner(db, petID, projectID) || (owner ? owner.pet_id !== petID || (owner.projectID ?? undefined) !== projectID : mode !== 'new')) throw invalid();
        const previous = db.prepare(`SELECT session_id, replayable, ${fields} FROM turns WHERE request_id = ?`).get(requestID);
        if (previous) {
          if (previous.session_id !== id || previous.user !== user || previous.assistant !== assistant || previous.replayable !== Number(replayable)) throw invalid();
        } else {
          if (!owner) db.prepare(`INSERT INTO sessions(id, pet_id, number, last_seq, completed_at)
            SELECT ?, ?, COALESCE(MAX(number), 0) + 1, 0, ? FROM sessions WHERE pet_id = ?`).run(id, petID, completedAt, petID);
          if (!owner && projectID) db.prepare('INSERT INTO session_projects(session_id, project_id) VALUES (?, ?)').run(id, projectID);
          const { lastInsertRowid } = db.prepare(`INSERT INTO turns(session_id, request_id, user_text, assistant_text, completed_at, replayable)
            VALUES (?, ?, ?, ?, ?, ?)`).run(id, requestID, user, assistant, completedAt, Number(replayable));
          db.prepare('UPDATE sessions SET last_seq = ?, completed_at = ? WHERE id = ?').run(lastInsertRowid, completedAt, id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  async createProject(petID: string, project: ChatProject) {
    if (!petId(petID) || !isChatProject(project)) throw invalid();
    return this.run(db => {
      const { changes } = db.prepare(`INSERT INTO projects(id, pet_id, name)
        SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM projects WHERE pet_id = ?) < ?`).run(project.id, petID, project.name, petID, maxChatProjects);
      if (!changes) throw invalid();
      return project;
    });
  }
  async listProjects(petID: string): Promise<ChatProject[]> {
    if (!petId(petID)) throw invalid();
    return this.run(db => db.prepare('SELECT id, name FROM projects WHERE pet_id = ? ORDER BY rowid DESC LIMIT ?').all(petID, maxChatProjects).map(row => {
      if (!isChatProject(row)) throw invalid();
      return { id: row.id, name: row.name };
    }));
  }
  async list(petID: string, before?: string, projectID?: string): Promise<ChatHistoryPage> {
    if (!isHistoryInput('list', { petID, before, projectID })) throw invalid();
    return this.run(db => {
      const limit = chatHistoryPageSize + 1;
      const filter = projectID === undefined ? '' : projectID === 'unassigned' ? ` AND ${projectColumn} IS NULL` : ` AND ${projectColumn} = ?`;
      const scope = projectID && projectID !== 'unassigned' ? [petID, projectID] : [petID];
      const anchor = before === undefined ? undefined : db.prepare(`SELECT t.seq FROM turns t
        JOIN sessions s ON s.id = t.session_id WHERE t.request_id = ? AND s.pet_id = ?${filter}`).get(before, ...scope)?.seq;
      if (before !== undefined && typeof anchor !== 'number') throw invalid();
      // The boundary turn never moves when its session receives a new reply.
      const select = `SELECT s.id, s.number, s.completed_at AS completedAt, t.request_id AS cursor, ${projectColumn} AS projectID
        FROM sessions s JOIN turns t ON t.seq = s.last_seq AND t.session_id = s.id WHERE s.pet_id = ?${filter}`;
      const results = typeof anchor === 'number'
        ? db.prepare(`${select} AND s.last_seq < ? ORDER BY s.last_seq DESC LIMIT ?`).all(...scope, anchor, limit)
        : db.prepare(`${select} ORDER BY s.last_seq DESC LIMIT ?`).all(...scope, limit);
      const rows = results.slice(0, chatHistoryPageSize).map(({ id, number, completedAt, projectID }) => ({ id, number, completedAt, ...(projectID !== null && { projectID }) }));
      const page = { rows, nextBefore: results.length === limit ? results[chatHistoryPageSize - 1]?.cursor : null };
      if (!isHistoryPage(page)) throw invalid();
      return page;
    });
  }
  async detail(petID: string, id: string, before?: string): Promise<ChatHistoryDetail | undefined> {
    if (!isHistoryInput('detail', { petID, id, before })) throw invalid();
    return this.run(db => {
      const session = db.prepare(`SELECT s.id, s.number, s.completed_at AS completedAt, ${projectColumn} AS projectID FROM sessions s WHERE pet_id = ? AND id = ?`).get(petID, id);
      if (!session) return undefined;
      const limit = chatHistoryDetailSize + 1;
      const anchor = before === undefined ? undefined : db.prepare('SELECT seq FROM turns WHERE session_id = ? AND request_id = ?').get(id, before)?.seq;
      if (before !== undefined && typeof anchor !== 'number') return undefined;
      const rows = typeof anchor === 'number'
        ? db.prepare(`SELECT ${fields} FROM turns WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`).all(id, anchor, limit)
        : db.prepare(`SELECT ${fields} FROM turns WHERE session_id = ? ORDER BY seq DESC LIMIT ?`).all(id, limit);
      if (before !== undefined && rows.length === 0) return undefined;
      const detail = { session: { id: session.id, number: session.number, completedAt: session.completedAt, ...(session.projectID !== null && { projectID: session.projectID }) }, ...(before && { before }), turns: rows.slice(0, chatHistoryDetailSize).reverse().map(row => ({ ...row })), hasEarlier: rows.length === limit };
      if (!isHistoryDetail(detail, id, before) || !detail.turns.every(turn => safeChatFields([turn.user, turn.assistant]))) throw invalid();
      return detail;
    });
  }
  async completed(petID: string, conversation: ChatConversation, turnID: string, user: string) {
    return this.run(db => {
      const row = db.prepare(`SELECT request_id AS requestID, user_text AS user, assistant_text AS assistant, turns.completed_at AS completedAt, turns.session_id, pet_id, replayable, ${projectColumn} AS projectID
        FROM turns JOIN sessions s ON s.id = turns.session_id WHERE request_id = ?`).get(turnID);
      if (!row) return undefined;
      if (row.pet_id !== petID || row.session_id !== conversation.id || (row.projectID ?? undefined) !== conversation.projectID || row.user !== user) return { status: 'conflict' } as const;
      if (!isHistoryTurn({ requestID: row.requestID, user: row.user, assistant: row.assistant, completedAt: row.completedAt }) ||
        typeof row.assistant !== 'string' || !safeChatFields([user, row.assistant]) || (row.replayable !== 0 && row.replayable !== 1)) throw invalid();
      return { status: 'completed', text: row.assistant, replayable: row.replayable === 1 } as const;
    });
  }
  async replay(petID: string, conversation: ChatConversation): Promise<ChatExchange[] | undefined> {
    if (!petId(petID) || !isChatConversation(conversation)) throw invalid();
    return this.run(db => {
      const { id, mode, projectID } = conversation;
      const owner = sessionOwner(db, id);
      if (!projectOwner(db, petID, projectID)) return undefined;
      if (!owner) return mode === 'new' ? [] : undefined;
      if (owner.pet_id !== petID || (owner.projectID ?? undefined) !== projectID) return undefined;
      const rows = db.prepare(`SELECT ${fields} FROM turns WHERE session_id = ? AND replayable = 1 ORDER BY seq DESC LIMIT 5`).all(id);
      return rows.reverse().map(row => {
        if (!isHistoryTurn(row) || !safeChatFields([row.user, row.assistant])) throw invalid();
        return { user: row.user, assistant: row.assistant };
      });
    });
  }
  async clear(petID: string) {
    if (!petId(petID)) throw invalid();
    return this.run(db => { db.prepare('DELETE FROM sessions WHERE pet_id = ?').run(petID); });
  }
  close(): Promise<void> {
    this.closing ??= this.queue.then(() => { this.db?.close(); });
    return this.closing;
  }
}
