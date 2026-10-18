import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
const db = new DatabaseSync(workerData.path);
// SQLite's built-in lower() only folds ASCII. Match the TUI's Unicode search.
db.function("hikaro_lower", { deterministic: true }, (text) =>
  text.toLowerCase(),
);
if (workerData.path !== ":memory:") chmodSync(workerData.path, 0o600);
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
);
// Serialize schema creation and migration with one durable commit. FULL remains
// enabled; fresh stores avoid a separate filesystem sync for each DDL statement.
db.exec("BEGIN IMMEDIATE");
try {
  db.exec(`
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,cwd TEXT NOT NULL,createdAt INTEGER NOT NULL,parentId TEXT);
CREATE TABLE IF NOT EXISTS session_models(sessionId TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_state(cwd TEXT PRIMARY KEY,sessionId TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_drafts(sessionId TEXT PRIMARY KEY,text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS context_checkpoints(sessionId TEXT PRIMARY KEY,seq INTEGER NOT NULL,throughSeq INTEGER NOT NULL,summary TEXT NOT NULL,timestamp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,timestamp INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_events ON events(sessionId,seq);
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,workspace TEXT,path TEXT,line INTEGER,text TEXT,hash TEXT,vector TEXT,model TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,text);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,task TEXT NOT NULL,runAt INTEGER NOT NULL,state TEXT NOT NULL,owner TEXT,leaseUntil INTEGER,error TEXT);
CREATE TABLE IF NOT EXISTS leases(sessionId TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_run_events ON events(sessionId,seq) WHERE type IN ('run.start','run.end');
CREATE TABLE IF NOT EXISTS rpc_commands(workspace TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,method TEXT NOT NULL,digest TEXT NOT NULL,hostInstanceId TEXT NOT NULL,sessionId TEXT,status TEXT NOT NULL,runId TEXT,operationId TEXT,error TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(workspace,scope,id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
  if (
    !db
      .prepare("PRAGMA table_info(leases)")
      .all()
      .some((column) => column.name === "epoch")
  )
    db.exec("ALTER TABLE leases ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
function assertLease(sessionId, lease) {
  const current = db
    .prepare("SELECT owner,epoch,expires FROM leases WHERE sessionId=?")
    .get(sessionId);
  if (lease) {
    if (
      !current ||
      current.owner !== lease.owner ||
      current.epoch !== lease.epoch ||
      current.expires <= Date.now()
    )
      throw Error("Session lease lost; execution no longer owns this session");
  } else if (current && current.expires > Date.now()) {
    throw Error("Session lease required while execution is active");
  }
}
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
        "context_checkpoints",
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
  sessions({ offset = 0, limit = 100, cwd, query = "" } = {}) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw Error("Invalid session pagination");
    if (typeof query !== "string" || query.length > 512)
      throw Error("Session search must be at most 512 characters");
    const where = [],
      args = [];
    if (cwd !== undefined) {
      where.push("s.cwd=?");
      args.push(cwd);
    }
    const text = query.trim().toLowerCase();
    if (text) {
      where.push(
        "(instr(hikaro_lower(s.title),?)>0 OR instr(lower(s.id),?)>0)",
      );
      args.push(text, text);
    }
    return db
      .prepare(
        sessionQuery +
          (where.length ? " WHERE " + where.join(" AND ") : "") +
          " ORDER BY s.createdAt DESC, s.rowid DESC LIMIT ? OFFSET ?",
      )
      .all(...args, Math.min(limit, 100), offset)
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
  messagePage({ sessionId, before, after, limit = 20, bounded = false }) {
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
      const { providerData, images, ...original } = JSON.parse(r.data).message;
      const message = bounded
        ? {
            role: original.role,
            timestamp: original.timestamp,
            text: original.text.slice(0, 20000),
            textLength: original.text.length,
            ...(original.thinking
              ? {
                  thinking: original.thinking.slice(0, 4000),
                  thinkingLength: original.thinking.length,
                }
              : {}),
            ...(original.name ? { name: original.name.slice(0, 256) } : {}),
            ...(original.callId ? { callId: original.callId } : {}),
            ...(original.isError ? { isError: true } : {}),
            ...(original.toolCalls?.length
              ? {
                  toolCalls: original.toolCalls.slice(0, 32).map((call) => ({
                    id: call.id.slice(0, 128),
                    name: call.name.slice(0, 256),
                    arguments: {},
                  })),
                  toolCallsTruncated: true,
                }
              : {}),
          }
        : original;
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
  messageContent({ sessionId, seq, field, offset, limit, image }) {
    const row = db
      .prepare("SELECT type,data FROM events WHERE sessionId=? AND seq=?")
      .get(sessionId, seq);
    if (!row) throw Error("Content not found in this session");
    const event = JSON.parse(row.data);
    if (field === "artifact") {
      if (row.type !== "tool.end") throw Error("Not a tool result");
      return {
        data:
          event.result?.data?.artifact ??
          event.result?.data?.process?.artifact ??
          "",
        encoding: "host-artifact-reference",
        total: 0,
        nextOffset: null,
      };
    }
    if (row.type !== "message") throw Error("Not a message");
    const message = event.message;
    const value =
      field === "image"
        ? message.images?.[image]?.data
        : field === "toolCalls"
          ? JSON.stringify(message.toolCalls ?? [])
          : message[field];
    if (typeof value !== "string") throw Error("Message content not found");
    const end = Math.min(value.length, offset + limit);
    return {
      data: value.slice(offset, end),
      total: value.length,
      nextOffset: end < value.length ? end : null,
      encoding: field === "image" ? "base64" : "utf16",
      ...(field === "image"
        ? { mimeType: message.images[image].mimeType }
        : {}),
    };
  },
  append({ sessionId, type, data, lease }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Ownership validation and insertion share the writer transaction, so a
      // successor cannot take over between the check and the event commit.
      assertLease(sessionId, lease);
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
      db.exec("COMMIT");
      return {
        sessionId,
        seq: Number(r.lastInsertRowid),
        type,
        data,
        timestamp,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
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
  contextSourcePage({ sessionId, after, through, limit = 40 }) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(through) ||
      through < after ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw Error("Invalid context source range");
    const rows = db
      .prepare(
        "SELECT seq,data FROM events WHERE sessionId=? AND type='message' AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
      )
      .iterate(sessionId, after, through, Math.min(limit, 100));
    const items = [];
    let bytes = 0;
    for (const row of rows) {
      const { providerData, images, ...content } = JSON.parse(row.data).message;
      const message = {
        ...content,
        ...(images?.length
          ? {
              images: images.map((image) => ({
                mimeType: image.mimeType,
                data: "",
              })),
            }
          : {}),
      };
      const size = Buffer.byteLength(JSON.stringify(message));
      if (items.length && bytes + size > 450000) break;
      items.push({ seq: row.seq, message });
      bytes += size;
    }
    return items;
  },
  commitContextCheckpoint({
    sessionId,
    throughSeq,
    summary,
    expectedCheckpointSeq,
    expectedLastMessageSeq,
    lease,
    cancellation,
  }) {
    if (
      !lease ||
      typeof summary !== "string" ||
      !summary.trim() ||
      Buffer.byteLength(summary) > 65536 ||
      ![throughSeq, expectedCheckpointSeq, expectedLastMessageSeq].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw Error("Invalid context checkpoint");
    db.exec("BEGIN IMMEDIATE");
    try {
      const cancelled = cancellation ? new Int32Array(cancellation) : undefined;
      if (cancelled && Atomics.load(cancelled, 0) === 1)
        throw Error("Context checkpoint cancelled");
      assertLease(sessionId, lease);
      const previous = db
        .prepare(
          "SELECT seq,throughSeq FROM context_checkpoints WHERE sessionId=?",
        )
        .get(sessionId);
      const latest = db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE sessionId=? AND type='message'",
        )
        .get(sessionId).seq;
      if (
        (previous?.seq ?? 0) !== expectedCheckpointSeq ||
        latest !== expectedLastMessageSeq
      )
        throw Error("Context source or checkpoint changed before commit");
      if (
        throughSeq <= (previous?.throughSeq ?? 0) ||
        throughSeq >= latest ||
        !db
          .prepare(
            "SELECT 1 FROM events WHERE sessionId=? AND type='message' AND seq>? AND seq<=? LIMIT 1",
          )
          .get(sessionId, previous?.throughSeq ?? 0, throughSeq)
      )
        throw Error("Checkpoint must advance over completed source messages");
      const next = db
        .prepare(
          "SELECT data FROM events WHERE sessionId=? AND type='message' AND seq>? ORDER BY seq LIMIT 1",
        )
        .get(sessionId, throughSeq);
      if (!next || JSON.parse(next.data).message.role !== "user")
        throw Error("Checkpoint must end at a user-turn boundary");
      const timestamp = Date.now();
      const data = {
        source: sessionId,
        throughSeq,
        previousCheckpointSeq: expectedCheckpointSeq,
        summary,
      };
      const event = db
        .prepare(
          "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,?,?,?)",
        )
        .run(sessionId, "context.checkpoint", JSON.stringify(data), timestamp);
      const seq = Number(event.lastInsertRowid);
      db.prepare(
        "INSERT INTO context_checkpoints VALUES(?,?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET seq=excluded.seq,throughSeq=excluded.throughSeq,summary=excluded.summary,timestamp=excluded.timestamp",
      ).run(sessionId, seq, throughSeq, summary, timestamp);
      // Atomically choose commit or cancellation. Cancellation after this point
      // cannot revoke a valid checkpoint; source messages remain untouched.
      if (cancelled && Atomics.compareExchange(cancelled, 0, 0, 2) === 1)
        throw Error("Context checkpoint cancelled");
      db.exec("COMMIT");
      return { seq, throughSeq, summary, timestamp };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  contextHistory({ sessionId, after = 0 }) {
    if (!Number.isSafeInteger(after) || after < 0)
      throw Error("Invalid context cursor");
    const checkpoint = db
      .prepare(
        "SELECT seq,throughSeq,summary,timestamp FROM context_checkpoints WHERE sessionId=?",
      )
      .get(sessionId);
    const boundary = Math.max(after, checkpoint?.throughSeq ?? 0);
    const rows = db
      .prepare(
        "SELECT seq,data FROM events WHERE sessionId=? AND type='message' AND seq>? ORDER BY seq DESC",
      )
      .iterate(sessionId, boundary);
    const messages = [];
    let bytes = 0,
      truncated = false,
      lastMessageSeq = checkpoint?.throughSeq ?? 0;
    for (const row of rows) {
      if (!messages.length) lastMessageSeq = row.seq;
      const size = Buffer.byteLength(row.data);
      if (bytes + size > 8 * 1024 * 1024) {
        truncated = true;
        break;
      }
      messages.push(JSON.parse(row.data).message);
      bytes += size;
    }
    messages.reverse();
    if (!truncated) return { messages, omitted: 0, checkpoint, lastMessageSeq };
    const firstUser = messages.findIndex((message) => message.role === "user");
    if (firstUser < 0)
      throw Error(
        "Current turn exceeds the history capacity. Start a branch or compact the session.",
      );
    messages.splice(0, firstUser);
    const total = db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE sessionId=? AND type='message' AND seq>?",
      )
      .get(sessionId, boundary).count;
    return {
      messages,
      omitted: total - messages.length,
      checkpoint,
      lastMessageSeq,
    };
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
    return !!handlers.acquireLease({ sessionId, owner });
  },
  acquireLease({ sessionId, owner }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      let lease;
      if (db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) {
        const now = Date.now();
        lease = db
          .prepare(
            "INSERT INTO leases(sessionId,owner,expires,epoch) VALUES(?,?,?,1) ON CONFLICT(sessionId) DO UPDATE SET owner=excluded.owner,expires=excluded.expires,epoch=leases.epoch+1 WHERE leases.expires<=? AND leases.owner<>? RETURNING owner,epoch",
          )
          .get(sessionId, owner, now + 30000, now, owner);
        // Repeated acquisition is idempotent while live; renewal is separate.
        lease ??= db
          .prepare(
            "SELECT owner,epoch FROM leases WHERE sessionId=? AND owner=? AND expires>?",
          )
          .get(sessionId, owner, now);
      }
      db.exec("COMMIT");
      return lease;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  renewLease({ sessionId, lease }) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Read time after waiting for the writer lock; a blocked renewal must not
      // resurrect a lease that expired while the connection was waiting.
      const now = Date.now();
      const renewed =
        db
          .prepare(
            "UPDATE leases SET expires=? WHERE sessionId=? AND owner=? AND epoch=? AND expires>?",
          )
          .run(now + 30000, sessionId, lease.owner, lease.epoch, now).changes >
        0;
      db.exec("COMMIT");
      return renewed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  assertLease({ sessionId, lease }) {
    assertLease(sessionId, lease);
  },
  releaseLease({ sessionId, lease }) {
    db.prepare(
      "UPDATE leases SET expires=0 WHERE sessionId=? AND owner=? AND epoch=?",
    ).run(sessionId, lease.owner, lease.epoch);
  },
  release({ sessionId, owner }) {
    // Retain the epoch even after release, otherwise an old token can become valid.
    db.prepare("UPDATE leases SET expires=0 WHERE sessionId=? AND owner=?").run(
      sessionId,
      owner,
    );
  },
  latestRunEvent({ sessionId }) {
    const row = db
      .prepare(
        "SELECT * FROM events WHERE sessionId=? AND type IN ('run.start','run.end') ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId);
    return row && decode(row);
  },
  commandReceipt({ workspace, scope, id, hostInstanceId }) {
    const row = db
      .prepare(
        "SELECT * FROM rpc_commands WHERE workspace=? AND scope=? AND id=?",
      )
      .get(workspace, scope, id);
    if (row) {
      const { workspace: _, ...receipt } = row;
      if (
        receipt.status === "accepted" &&
        receipt.hostInstanceId !== hostInstanceId
      )
        receipt.status = "unknown";
      for (const key of ["runId", "operationId", "error"])
        if (receipt[key] === null) delete receipt[key];
      return receipt;
    }
    // Legacy IDs were global and had no scope or digest. Suppress execution
    // without exposing the original scope's session or claiming equivalence.
    const legacy = db
      .prepare(
        "SELECT c.createdAt FROM commands c JOIN sessions s ON s.id=c.sessionId WHERE c.id=? AND s.cwd=?",
      )
      .get(id, workspace);
    return legacy
      ? {
          id,
          scope,
          method: "prompt",
          digest: null,
          hostInstanceId: null,
          sessionId: null,
          status: "unknown",
          createdAt: legacy.createdAt,
          updatedAt: legacy.createdAt,
        }
      : null;
  },
  acceptCommand(args) {
    const {
      workspace,
      scope,
      id,
      method,
      digest,
      hostInstanceId,
      sessionId,
      operationId,
    } = args;
    if (!/^[a-f0-9]{64}$/.test(digest)) throw Error("Invalid command digest");
    db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = handlers.commandReceipt(args);
      if (receipt) {
        if (
          receipt.digest !== null &&
          (receipt.digest !== digest || receipt.method !== method)
        )
          throw Error("Command ID payload conflict");
        db.exec("COMMIT");
        return { inserted: false, receipt };
      }
      if (
        db
          .prepare("SELECT count(*) AS n FROM rpc_commands WHERE workspace=?")
          .get(workspace).n >= 100000
      )
        throw Error("Command receipt capacity exceeded; existing IDs retained");
      const now = Date.now();
      db.prepare(
        "INSERT INTO rpc_commands(workspace,scope,id,method,digest,hostInstanceId,sessionId,status,operationId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,'accepted',?,?,?)",
      ).run(
        workspace,
        scope,
        id,
        method,
        digest,
        hostInstanceId,
        sessionId,
        operationId ?? null,
        now,
        now,
      );
      const inserted = handlers.commandReceipt(args);
      db.exec("COMMIT");
      return { inserted: true, receipt: inserted };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
  finishCommand({
    workspace,
    scope,
    id,
    hostInstanceId,
    status,
    sessionId,
    runId,
    operationId,
    error,
  }) {
    if (status !== "completed" && status !== "failed")
      throw Error("Invalid command completion");
    if (
      error !== undefined &&
      (typeof error !== "string" || error.length > 4096)
    )
      throw Error("Command error capacity exceeded");
    const changed = db
      .prepare(
        "UPDATE rpc_commands SET status=?,sessionId=coalesce(?,sessionId),runId=coalesce(?,runId),operationId=coalesce(?,operationId),error=?,updatedAt=? WHERE workspace=? AND scope=? AND id=? AND hostInstanceId=? AND status='accepted'",
      )
      .run(
        status,
        sessionId ?? null,
        runId ?? null,
        operationId ?? null,
        error ?? null,
        Date.now(),
        workspace,
        scope,
        id,
        hostInstanceId,
      ).changes;
    if (!changed)
      throw Error("Command receipt ownership lost or already settled");
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
