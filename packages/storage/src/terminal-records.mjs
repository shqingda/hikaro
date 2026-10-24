/** Background terminal outcomes, kept so /tasks can explain them after restart. */
export function terminalRecordHandlers(prepare) {
  return {
    saveTerminalRecord({
      id,
      owner,
      command,
      state,
      exitCode,
      output,
      processNote,
    }) {
      if (
        typeof id !== "string" ||
        typeof owner !== "string" ||
        typeof command !== "string" ||
        typeof state !== "string" ||
        typeof output !== "string" ||
        (processNote !== undefined && typeof processNote !== "string") ||
        (exitCode !== undefined &&
          exitCode !== null &&
          !Number.isInteger(exitCode))
      )
        throw Error("Invalid terminal record");
      const now = Date.now();
      prepare(
        "INSERT INTO terminal_records(id,owner,command,state,exitCode,output,processNote,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,exitCode=excluded.exitCode,output=excluded.output,processNote=excluded.processNote,updatedAt=excluded.updatedAt",
      ).run(
        id,
        owner,
        command.slice(0, 16000),
        state.slice(0, 64),
        exitCode ?? null,
        output.slice(-64000),
        processNote?.slice(0, 4096) ?? null,
        now,
        now,
      );
    },
    terminalRecords({ owner }) {
      return prepare(
        "SELECT id,owner,command,state,exitCode,output,processNote,createdAt FROM terminal_records WHERE owner=? ORDER BY createdAt,rowid LIMIT 64",
      )
        .all(owner)
        .map((row) => ({
          ...row,
          exitCode: row.exitCode === null ? undefined : row.exitCode,
          processNote: row.processNote === null ? undefined : row.processNote,
        }));
    },
  };
}
