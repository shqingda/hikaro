/** Reuse compiled SQL, never query results. Keep dynamic statement shapes bounded. */
export function createStatementCache(db, limit = 128) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw Error("Invalid statement cache limit");
  const statements = new Map();
  return (sql) => {
    let statement = statements.get(sql);
    if (statement) statements.delete(sql);
    else statement = db.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > limit)
      statements.delete(statements.keys().next().value);
    return statement;
  };
}
