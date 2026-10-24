const validRevision = (revision) =>
  Number.isSafeInteger(revision) && revision >= 0;
export function assertDraftRevision(revision, current) {
  if (!validRevision(revision)) throw Error("Invalid question draft revision");
  if (revision !== current)
    throw Error("Question draft changed; reopen it before submitting answers");
}
function validateDraft(draft, questions) {
  const record = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const ids = new Set(questions.map((question) => question.id));
  const values = (value, answers) =>
    record(value) &&
    Object.entries(value).every(
      ([id, text]) =>
        ids.has(id) &&
        typeof text === "string" &&
        text.length <= 100000 &&
        (!answers || text.trim().length > 0),
    );
  if (
    !record(draft) ||
    Object.keys(draft).some(
      (key) => !["answers", "inputs", "position"].includes(key),
    ) ||
    !values(draft.answers, true) ||
    !values(draft.inputs, false) ||
    !record(draft.position)
  )
    throw Error("Invalid question draft");
  const position = draft.position;
  if (position.kind === "review") {
    if (
      Object.keys(position).length !== 1 ||
      Object.keys(draft.answers).length !== questions.length
    )
      throw Error("Invalid question draft review position");
  } else if (
    !["question", "input"].includes(position.kind) ||
    !ids.has(position.questionId) ||
    Object.keys(position).some((key) => !["kind", "questionId"].includes(key))
  )
    throw Error("Invalid question draft position");
  const data = JSON.stringify(draft);
  if (Buffer.byteLength(data) > 512 * 1024)
    throw Error("Question draft exceeds 512 KiB");
  return data;
}
/** Pending identity, permission, CAS and changes share one SQLite transaction. */
export function questionDraftHandlers(db, prepare, pendingQuestion) {
  const snapshot = ({ id, sessionId, scope }) => {
    const row = prepare(
      "SELECT revision,data FROM question_drafts WHERE id=? AND sessionId=? AND scope=?",
    ).get(id, sessionId, scope);
    return row
      ? { revision: row.revision, draft: JSON.parse(row.data) }
      : { revision: 0, draft: null };
  };
  const transaction = (write, operation) => {
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    questionDraft(input) {
      return transaction(false, () => {
        pendingQuestion(input);
        return snapshot(input);
      });
    },
    saveQuestionDraft(input) {
      return transaction(true, () => {
        const question = pendingQuestion(input);
        const { id, sessionId, scope, expectedRevision, draft } = input;
        if (
          !validRevision(expectedRevision) ||
          expectedRevision === Number.MAX_SAFE_INTEGER
        )
          throw Error("Invalid question draft revision");
        const data = validateDraft(draft, question.questions);
        const current = snapshot(input);
        if (current.revision !== expectedRevision)
          return { conflict: true, current };
        const revision = expectedRevision + 1;
        prepare(
          "INSERT INTO question_drafts(id,sessionId,scope,revision,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
        ).run(id, sessionId, scope, revision, data);
        return { revision };
      });
    },
  };
}
