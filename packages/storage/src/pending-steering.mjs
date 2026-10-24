/** All consumption changes, including lease validation, share a writer transaction. */
export function steeringHandlers(db, prepare, assertLease) {
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const validate = (text) => {
    if (typeof text !== "string" || !text.trim() || text.length > 100000)
      throw Error("Invalid steering message");
  };
  const changed = (result) => {
    if (!result.changes)
      throw Error("Steering message is no longer pending; refresh the list.");
  };
  return {
    pendingSteering({ sessionId }) {
      return prepare(
        "SELECT data FROM pending_steering WHERE sessionId=? ORDER BY position,id",
      )
        .all(sessionId)
        .map((row) => JSON.parse(row.data));
    },
    insertPendingSteering({ sessionId, item }) {
      validate(item.text);
      return transaction(() => {
        if (!prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId))
          throw Error("Session not found");
        if (
          prepare(
            "SELECT COUNT(*) AS count FROM pending_steering WHERE sessionId=?",
          ).get(sessionId).count >= 16
        )
          throw Error("Steering queue is full");
        const data = JSON.stringify({
          id: item.id,
          text: item.text,
          scope: item.scope,
        });
        prepare(
          "INSERT INTO pending_steering SELECT ?,?,?,COALESCE(MAX(position),0)+1 FROM pending_steering WHERE sessionId=?",
        ).run(sessionId, item.id, data, sessionId);
      });
    },
    updatePendingSteering({ sessionId, id, text }) {
      validate(text);
      changed(
        prepare(
          "UPDATE pending_steering SET data=json_set(data,'$.text',?) WHERE sessionId=? AND id=?",
        ).run(text, sessionId, id),
      );
    },
    prioritizePendingSteering({ sessionId, id }) {
      changed(
        prepare(
          "UPDATE pending_steering SET position=(SELECT COALESCE(MIN(position),0)-1 FROM pending_steering WHERE sessionId=?) WHERE sessionId=? AND id=?",
        ).run(sessionId, sessionId, id),
      );
    },
    takePendingSteering({ sessionId, id }) {
      return !!prepare(
        "DELETE FROM pending_steering WHERE sessionId=? AND id=?",
      ).run(sessionId, id).changes;
    },
    consumePendingSteering({ sessionId, id, lease }) {
      return transaction(() => {
        if (!lease) throw Error("Session lease required to consume steering");
        assertLease(sessionId, lease);
        const row = prepare(
          "SELECT data FROM pending_steering WHERE sessionId=? AND id=?",
        ).get(sessionId, id);
        if (!row) return;
        const item = JSON.parse(row.data),
          timestamp = Date.now();
        const data = {
          message: { role: "user", text: item.text, timestamp },
          steeringId: id,
        };
        const result = prepare(
          "INSERT INTO events(sessionId,type,data,timestamp) VALUES(?,?,?,?)",
        ).run(sessionId, "message", JSON.stringify(data), timestamp);
        prepare(
          "UPDATE sessions SET title=? WHERE id=? AND title='New session'",
        ).run(item.text.slice(0, 80), sessionId);
        prepare("DELETE FROM pending_steering WHERE sessionId=? AND id=?").run(
          sessionId,
          id,
        );
        return {
          sessionId,
          seq: Number(result.lastInsertRowid),
          type: "message",
          data,
          timestamp,
        };
      });
    },
  };
}
