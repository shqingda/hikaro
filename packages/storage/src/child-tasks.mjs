/** Delegated child-agent outcomes, kept so /tasks can explain them after restart. */
export function childTaskHandlers(prepare) {
  return {
    saveChildTask({ id, parentId, task, state, output }) {
      if (
        typeof id !== "string" ||
        typeof parentId !== "string" ||
        typeof task !== "string" ||
        typeof state !== "string" ||
        typeof output !== "string"
      )
        throw Error("Invalid child task record");
      const now = Date.now();
      prepare(
        "INSERT INTO child_tasks(id,parentId,task,state,output,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,output=excluded.output,updatedAt=excluded.updatedAt",
      ).run(
        id,
        parentId,
        task.slice(0, 16000),
        state.slice(0, 64),
        output.slice(-64000),
        now,
        now,
      );
    },
    childTaskTree({ parentId }) {
      // Bounded depth and row count: delegation is at most two levels deep.
      return prepare(
        `WITH RECURSIVE tree(id,depth) AS (
          SELECT id,1 FROM child_tasks WHERE parentId=?
          UNION ALL SELECT c.id,tree.depth+1 FROM child_tasks c JOIN tree ON c.parentId=tree.id WHERE tree.depth<4
        ) SELECT c.id,c.parentId,c.task,c.state,c.output,c.createdAt FROM tree JOIN child_tasks c ON c.id=tree.id ORDER BY c.createdAt,c.rowid LIMIT 200`,
      ).all(parentId);
    },
  };
}
