const scanLimit = 200;
const pageLimit = 20;
const validSequence = (value) => Number.isSafeInteger(value) && value >= 0;
/** Each fixed-type lookup is one run-identity index seek, even with duplicate events. */
export function executionHistoryHandlers(db, prepare) {
  const transaction = (operation) => {
    db.exec("BEGIN");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const snapshotFor = (sessionId, snapshot) => {
    if (!prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId))
      throw Error("Session not found");
    const latest =
      prepare(
        "SELECT seq FROM events WHERE sessionId=? AND type IN ('run.start','run.end') ORDER BY seq DESC LIMIT 1",
      ).get(sessionId)?.seq ?? 0;
    if (snapshot === undefined) return latest;
    if (!validSequence(snapshot) || snapshot > latest)
      throw Error("Invalid execution history snapshot");
    return snapshot;
  };
  const readRun = (sessionId, id, snapshot) => {
    const event = (type) => {
      const row = prepare(`SELECT seq,timestamp,
        CASE WHEN json_type(data,'$.provider')='text' THEN substr(json_extract(data,'$.provider'),1,4000) END AS provider,
        CASE WHEN json_type(data,'$.model')='text' THEN substr(json_extract(data,'$.model'),1,4000) END AS model,
        CASE WHEN json_type(data,'$.operation')='text' THEN substr(json_extract(data,'$.operation'),1,4000) END AS operation,
        CASE WHEN json_type(data,'$.status')='text' THEN substr(json_extract(data,'$.status'),1,80) END AS status,
        CASE WHEN json_type(data,'$.error')='text' THEN substr(json_extract(data,'$.error'),1,4000) END AS error,
        substr(CAST(json_extract(data,'$.usage') AS TEXT),1,2000) AS usageText
        FROM events WHERE sessionId=? AND type IN ('run.start','run.end')
        AND json_extract(data,'$.runId')=? AND type=? AND seq<=?
        ORDER BY seq DESC LIMIT 1`).get(sessionId, id, type, snapshot);
      if (!row) return;
      const { seq, timestamp, ...fields } = row;
      return {
        sessionId,
        seq,
        timestamp,
        type,
        data: {
          runId: id,
          ...Object.fromEntries(
            Object.entries(fields).filter(([, value]) => value !== null),
          ),
        },
      };
    };
    const start = event("run.start"),
      end = event("run.end");
    return start || end ? { id, start, end } : null;
  };
  return {
    runHistoryPage({ sessionId, snapshot: requestedSnapshot, before }) {
      return transaction(() => {
        const snapshot = snapshotFor(sessionId, requestedSnapshot);
        if (
          before !== undefined &&
          (requestedSnapshot === undefined ||
            !validSequence(before) ||
            before === 0 ||
            before > snapshot)
        )
          throw Error("Invalid execution history before cursor");
        const rows =
          before === undefined
            ? prepare(
                "SELECT seq,json_extract(data,'$.runId') AS runId FROM events WHERE sessionId=? AND type IN ('run.start','run.end') AND seq<=? ORDER BY seq DESC LIMIT ?",
              ).all(sessionId, snapshot, scanLimit + 1)
            : prepare(
                "SELECT seq,json_extract(data,'$.runId') AS runId FROM events WHERE sessionId=? AND type IN ('run.start','run.end') AND seq<=? AND seq<? ORDER BY seq DESC LIMIT ?",
              ).all(sessionId, snapshot, before, scanLimit + 1);
        const items = [],
          inspected = new Set();
        let scanned = 0;
        for (const row of rows.slice(0, scanLimit)) {
          scanned++;
          const id = row.runId;
          if (
            typeof id !== "string" ||
            !id ||
            id.length > 128 ||
            inspected.has(id)
          )
            continue;
          inspected.add(id);
          const run = readRun(sessionId, id, snapshot);
          if (Math.max(run?.start?.seq ?? 0, run?.end?.seq ?? 0) !== row.seq)
            continue;
          items.push(run);
          if (items.length === pageLimit) break;
        }
        // Use the last inspected event, never the fetched batch's last event:
        // a page can fill before all 200 candidates have been inspected.
        return {
          items,
          snapshot,
          nextBefore: scanned < rows.length ? rows[scanned - 1].seq : null,
        };
      });
    },
    runHistoryDetail({ sessionId, id, snapshot: requestedSnapshot }) {
      return transaction(() => {
        if (typeof id !== "string" || !id || id.length > 128)
          throw Error("Invalid run ID");
        return readRun(
          sessionId,
          id,
          snapshotFor(sessionId, requestedSnapshot),
        );
      });
    },
  };
}
