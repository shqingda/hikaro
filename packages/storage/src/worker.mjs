import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
const db = new DatabaseSync(workerData.path);
if (workerData.path !== ":memory:") chmodSync(workerData.path, 0o600);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,cwd TEXT NOT NULL,createdAt INTEGER NOT NULL,parentId TEXT);
CREATE TABLE IF NOT EXISTS session_models(sessionId TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_state(cwd TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_drafts(sessionId TEXT PRIMARY KEY,text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,timestamp INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_events ON events(sessionId,seq);
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,workspace TEXT,path TEXT,line INTEGER,text TEXT,hash TEXT,vector TEXT,model TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,text);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,task TEXT NOT NULL,runAt INTEGER NOT NULL,state TEXT NOT NULL,owner TEXT,leaseUntil INTEGER,error TEXT);
CREATE TABLE IF NOT EXISTS leases(sessionId TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
const decode = (r) => ({ ...r, data: JSON.parse(r.data) });
const sessionQuery =
  "SELECT s.*, m.data AS modelData FROM sessions s LEFT JOIN session_models m ON m.sessionId=s.id";
const decodeSession = (row) => {
  if (!row) return undefined;
  const { modelData, ...session } = row;
  return {
    ...session,
    ...(modelData ? { modelSelection: JSON.parse(modelData) } : {}),
  };
};
function saveModel(sessionId, modelSelection) {
  db.prepare(
    "INSERT INTO session_models VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET data=excluded.data",
  ).run(sessionId, JSON.stringify(modelSelection));
  db.prepare(
    "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,?,?,?)",
  ).run(
    sessionId,
    "model.changed",
    JSON.stringify({ selection: modelSelection }),
    Date.now(),
  );
}
function insertSession({ cwd, title, parentId, modelSelection }) {
  const session = {
    id: randomUUID(),
    title: title || "New session",
    cwd,
    createdAt: Date.now(),
    parentId,
  };
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
    session.id,
    session.title,
    cwd,
    session.createdAt,
    parentId ?? null,
  );
  if (modelSelection) saveModel(session.id, modelSelection);
  return { ...session, ...(modelSelection ? { modelSelection } : {}) };
}
const handlers = {
  rememberSession({ id }) {
    const session = handlers.session({ id });
    if (!session) throw Error("Session not found");
    db.prepare(
      "INSERT INTO workspace_state VALUES(?,?) ON CONFLICT(cwd) DO UPDATE SET sessionId=excluded.sessionId",
    ).run(session.cwd, id);
  },
  lastSession({ cwd }) {
    const row = db
      .prepare("SELECT sessionId FROM workspace_state WHERE cwd=?")
      .get(cwd);
    return row ? handlers.session({ id: row.sessionId }) : undefined;
  },
  renameSession({ id, title }) {
    if (typeof title !== "string" || !title.trim() || title.length > 120)
      throw Error("Session title must contain 1–120 characters");
    if (
      !db
        .prepare("UPDATE sessions SET title=? WHERE id=?")
        .run(title.trim(), id).changes
    )
      throw Error("Session not found");
    return handlers.session({ id });
  },
  draft({ id }) {
    return (
      db.prepare("SELECT text FROM session_drafts WHERE sessionId=?").get(id)
        ?.text ?? ""
    );
  },
  saveDraft({ id, text }) {
    if (typeof text !== "string" || text.length > 100000)
      throw Error("Draft exceeds 100,000 characters");
    if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id))
      throw Error("Session not found");
    if (text)
      db.prepare(
        "INSERT INTO session_drafts VALUES(?,?) ON CONFLICT(sessionId) DO UPDATE SET text=excluded.text",
      ).run(id, text);
    else db.prepare("DELETE FROM session_drafts WHERE sessionId=?").run(id);
  },
  deleteSession({ id }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(id))
        throw Error("Session not found");
      if (
        db
          .prepare("SELECT 1 FROM leases WHERE sessionId=? AND expires>?")
          .get(id, Date.now()) ||
        db
          .prepare(
            "SELECT 1 FROM jobs WHERE sessionId=? AND state='running' AND leaseUntil>?",
          )
          .get(id, Date.now())
      )
        throw Error("Stop the active run before deleting this session");
      for (const table of [
        "events",
        "session_models",
        "commands",
        "leases",
        "jobs",
      ])
        db.prepare(`DELETE FROM ${table} WHERE sessionId=?`).run(id);
      db.prepare("UPDATE sessions SET parentId=NULL WHERE parentId=?").run(id);
      for (const table of ["session_drafts", "workspace_state"])
        db.prepare(`DELETE FROM ${table} WHERE sessionId=?`).run(id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
  createSession(args) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const session = insertSession(args);
      db.exec("COMMIT");
      return session;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  setSessionModel({ sessionId, modelSelection }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId))
        throw Error("Session not found");
      if (
        db
          .prepare("SELECT 1 FROM leases WHERE sessionId=? AND expires>?")
          .get(sessionId, Date.now())
      )
        throw Error("Stop the active run before changing its model settings");
      saveModel(sessionId, modelSelection);
      const session = handlers.session({ id: sessionId });
      db.exec("COMMIT");
      return session;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  sessions({ offset = 0, limit = 100, cwd } = {}) {
    return cwd
      ? db
          .prepare(
            sessionQuery +
              " WHERE s.cwd=? ORDER BY s.createdAt DESC, s.rowid DESC LIMIT ? OFFSET ?",
          )
          .all(cwd, Math.min(limit, 100), offset)
          .map(decodeSession)
      : db
          .prepare(
            sessionQuery +
              " ORDER BY s.createdAt DESC, s.rowid DESC LIMIT ? OFFSET ?",
          )
          .all(Math.min(limit, 100), offset)
          .map(decodeSession);
  },
  forkSession({ id }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const source = handlers.session({ id });
      if (!source) throw Error("Session not found");
      const target = insertSession({
        cwd: source.cwd,
        title: "Branch: " + source.title,
        parentId: id,
        modelSelection: source.modelSelection,
      });
      db.prepare(
        "INSERT INTO events(sessionId,type,data,timestamp) SELECT ?,type,data,timestamp FROM events WHERE sessionId=? AND type='message' ORDER BY seq",
      ).run(target.id, id);
      db.exec("COMMIT");
      return target;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  session({ id }) {
    return decodeSession(db.prepare(sessionQuery + " WHERE s.id=?").get(id));
  },
  latestSeq({ sessionId }) {
    return db
      .prepare(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE sessionId=?",
      )
      .get(sessionId).seq;
  },
  messagePage({ sessionId, before, after, limit = 20 }) {
    const ascending = after !== undefined;
    const rows = db
      .prepare(
        `SELECT seq,data FROM events WHERE sessionId=? AND type='message' AND seq ${ascending ? ">" : "<"} ? ORDER BY seq ${ascending ? "ASC" : "DESC"} LIMIT ?`,
      )
      .iterate(
        sessionId,
        ascending ? after : (before ?? Number.MAX_SAFE_INTEGER),
        Math.min(limit, 100),
      );
    const items = [];
    let bytes = 0;
    for (const r of rows) {
      const { providerData, images, ...message } = JSON.parse(r.data).message;
      const size = Buffer.byteLength(JSON.stringify(message));
      if (items.length && bytes + size > 450000) break;
      items.push({
        seq: r.seq,
        message: {
          ...message,
          ...(images?.length ? { imageCount: images.length } : {}),
        },
      });
      bytes += size;
    }
    if (!ascending) items.reverse();
    const hasOlder =
      items.length > 0 &&
      !!db
        .prepare(
          "SELECT 1 FROM events WHERE sessionId=? AND type='message' AND seq<? LIMIT 1",
        )
        .get(sessionId, items[0].seq);
    const hasNewer =
      items.length > 0 &&
      !!db
        .prepare(
          "SELECT 1 FROM events WHERE sessionId=? AND type='message' AND seq>? LIMIT 1",
        )
        .get(sessionId, items.at(-1).seq);
    return { items, hasOlder, hasNewer };
  },
  append({ sessionId, type, data }) {
    const timestamp = Date.now();
    const r = db
      .prepare(
        "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,?,?,?)",
      )
      .run(sessionId, type, JSON.stringify(data), timestamp);
    if (type === "message" && data.message?.role === "user")
      db.prepare(
        "UPDATE sessions SET title=? WHERE id=? AND title='New session'",
      ).run(data.message.text.slice(0, 80), sessionId);
    return { sessionId, seq: Number(r.lastInsertRowid), type, data, timestamp };
  },
  events({ sessionId, after = 0, limit = 200 }) {
    return db
      .prepare(
        "SELECT * FROM events WHERE sessionId=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(sessionId, after, Math.min(limit, 1000))
      .map(decode);
  },
  messages({ sessionId, limit = 200 }) {
    const rows = db
      .prepare(
        "SELECT data FROM events WHERE sessionId=? AND type='message' ORDER BY seq DESC LIMIT ?",
      )
      .iterate(sessionId, Math.min(limit, 1000));
    const result = [];
    let bytes = 0;
    for (const row of rows) {
      const size = Buffer.byteLength(row.data);
      if (result.length && bytes + size > 8 * 1024 * 1024) break;
      result.push(JSON.parse(row.data).message);
      bytes += size;
    }
    return result.reverse();
  },
  indexReplace({ workspace, path, chunks }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const old = db
        .prepare("SELECT id FROM chunks WHERE workspace=? AND path=?")
        .all(workspace, path);
      for (const row of old)
        db.prepare("DELETE FROM chunks_fts WHERE id=?").run(row.id);
      db.prepare("DELETE FROM chunks WHERE workspace=? AND path=?").run(
        workspace,
        path,
      );
      for (const c of chunks) {
        db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)").run(
          c.id,
          workspace,
          path,
          c.line,
          c.text,
          c.hash,
          c.vector ? JSON.stringify(c.vector) : null,
          c.model ?? null,
        );
        db.prepare("INSERT INTO chunks_fts(id,text) VALUES(?,?)").run(
          c.id,
          c.text,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
  indexFiles({ workspace }) {
    return db
      .prepare(
        "SELECT path,hash FROM chunks WHERE workspace=? GROUP BY path,hash",
      )
      .all(workspace);
  },
  indexPrune({ workspace, paths }) {
    const keep = new Set(paths);
    for (const row of db
      .prepare("SELECT id,path FROM chunks WHERE workspace=?")
      .all(workspace)) {
      if (!keep.has(row.path)) {
        db.prepare("DELETE FROM chunks WHERE id=?").run(row.id);
        db.prepare("DELETE FROM chunks_fts WHERE id=?").run(row.id);
      }
    }
  },
  indexSearch({ workspace, query, vector, model }) {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const expression = words
      .slice(0, 20)
      .map((w) => '"' + w + '"')
      .join(" OR ");
    const lexical = db
      .prepare(
        "SELECT c.* FROM chunks_fts f JOIN chunks c ON c.id=f.id WHERE chunks_fts MATCH ? AND c.workspace=? ORDER BY rank LIMIT 24",
      )
      .all(expression, workspace);
    const scores = new Map(
      lexical.map((c, i) => [c.id, { chunk: c, score: 1 / (60 + i) }]),
    );
    if (vector) {
      const norm = Math.hypot(...vector);
      const rows = db
        .prepare(
          "SELECT * FROM chunks WHERE workspace=? AND model=? AND vector IS NOT NULL LIMIT 2000",
        )
        .all(workspace, model);
      const ranked = rows
        .map((c) => {
          const v = JSON.parse(c.vector);
          return {
            chunk: c,
            score:
              v.length === vector.length && norm
                ? vector.reduce((n, x, i) => n + x * v[i], 0) /
                  (norm * Math.hypot(...v) || 1)
                : -1,
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 24);
      ranked.forEach(({ chunk }, i) => {
        const existing = scores.get(chunk.id);
        scores.set(chunk.id, {
          chunk,
          score: (existing?.score ?? 0) + 1 / (60 + i),
        });
      });
    }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ chunk }) => ({ ...chunk, vector: undefined }));
  },
  putJob(job) {
    db.prepare(
      "INSERT INTO jobs(id,sessionId,task,runAt,state) VALUES(?,?,?,?,?)",
    ).run(job.id, job.sessionId, job.task, job.runAt, job.state);
  },
  jobs() {
    return db.prepare("SELECT * FROM jobs ORDER BY runAt DESC LIMIT 200").all();
  },
  claimJob({ owner, cwd }) {
    const now = Date.now();
    db.prepare(
      "UPDATE jobs SET state='interrupted',error='Execution lease expired; inspect before retrying' WHERE state='running' AND leaseUntil<?",
    ).run(now);
    return db
      .prepare(
        "UPDATE jobs SET state='running',owner=?,leaseUntil=? WHERE id=(SELECT jobs.id FROM jobs JOIN sessions ON sessions.id=jobs.sessionId WHERE jobs.state='queued' AND jobs.runAt<=? AND (? IS NULL OR sessions.cwd=?) ORDER BY jobs.runAt LIMIT 1) RETURNING *",
      )
      .get(owner, now + 30000, now, cwd ?? null, cwd ?? null);
  },
  finishJob({ id, owner, state, error }) {
    db.prepare("UPDATE jobs SET state=?,error=? WHERE id=? AND owner=?").run(
      state,
      error ?? null,
      id,
      owner,
    );
  },
  renewJob({ id, owner }) {
    return (
      db
        .prepare(
          "UPDATE jobs SET leaseUntil=? WHERE id=? AND owner=? AND state='running'",
        )
        .run(Date.now() + 30000, id, owner).changes > 0
    );
  },
  acquire({ sessionId, owner }) {
    if (!db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId))
      return false;
    const now = Date.now();
    return (
      db
        .prepare(
          "INSERT INTO leases VALUES(?,?,?) ON CONFLICT(sessionId) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? OR leases.owner=?",
        )
        .run(sessionId, owner, now + 30000, now, owner).changes > 0
    );
  },
  release({ sessionId, owner }) {
    db.prepare("DELETE FROM leases WHERE sessionId=? AND owner=?").run(
      sessionId,
      owner,
    );
  },
  claim({ commandId, sessionId }) {
    return (
      db
        .prepare("INSERT OR IGNORE INTO commands VALUES(?,?,?)")
        .run(commandId, sessionId, Date.now()).changes > 0
    );
  },
  close() {
    db.close();
  },
};
parentPort.on("message", ({ id, method, args }) => {
  try {
    if (!Object.hasOwn(handlers, method))
      throw Error("Unknown storage operation");
    const result = handlers[method](args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error) });
  }
});
