/** Project only bounded evidence fields; never scan unrelated tasks or infer associations. */
export function planEvidenceHandlers(prepare) {
  return {
    planEvidence({ sessionId, root, planId }) {
      const rows = prepare(`SELECT seq,type,
        substr(COALESCE(json_extract(data,'$.callId'),json_extract(data,'$.invocationId')),1,128) AS callId,
        substr(json_extract(data,'$.name'),1,80) AS name,
        substr(json_extract(data,'$.parentCallId'),1,128) AS parentCallId,
        json_extract(data,'$.plan.step') AS step,
        substr(json_extract(data,'$.runId'),1,128) AS runId,
        json_extract(data,'$.result.isError') AS isError,
        json_extract(data,'$.status') AS status,
        substr(COALESCE(json_extract(data,'$.result.text'),''),1,160) AS preview
        FROM events WHERE sessionId=? AND type IN ('tool.start','tool.end','plugin.start','plugin.end')
        AND json_extract(data,'$.plan.sessionId')=? AND json_extract(data,'$.plan.planId')=?
        ORDER BY seq DESC LIMIT 121`).all(sessionId, root, planId);
      const seen = new Set(),
        items = [];
      for (const row of rows.slice(0, 120)) {
        if (!row.callId || seen.has(row.callId)) continue;
        seen.add(row.callId);
        items.push({
          sessionId,
          seq: row.seq,
          callId: row.callId,
          name: row.name ?? "tool",
          ...(row.runId ? { runId: row.runId } : {}),
          ...(row.parentCallId ? { parentCallId: row.parentCallId } : {}),
          ...(Number.isInteger(row.step) && row.step >= 1 && row.step <= 12
            ? { step: row.step }
            : {}),
          status: row.type.endsWith(".start")
            ? "unknown"
            : row.status === "cancelled"
              ? "cancelled"
              : row.status === "failed" || row.isError
                ? "failed"
                : "completed",
          preview: row.preview.slice(0, 160),
        });
      }
      return {
        items: items.slice(0, 60),
        more: rows.length > 120 || items.length > 60,
      };
    },
    planEvidenceContent({ sessionId, root, planId, seq, offset, limit }) {
      const row =
        prepare(`SELECT substr(COALESCE(json_extract(data,'$.result.text'),''),1,60000) AS text,
        length(COALESCE(json_extract(data,'$.result.text'),'')) AS length, json_extract(data,'$.result.truncated') AS truncated
        FROM events WHERE sessionId=? AND seq=? AND type IN ('tool.end','plugin.end')
        AND json_extract(data,'$.plan.sessionId')=? AND json_extract(data,'$.plan.planId')=?`).get(
          sessionId,
          seq,
          root,
          planId,
        );
      if (!row) throw Error("Tool result not found for this plan and task");
      const end = Math.min(row.text.length, offset + limit);
      return {
        data: row.text.slice(offset, end),
        total: row.text.length,
        encoding: "utf16",
        nextOffset: end < row.text.length ? end : null,
        truncated: row.length > 60000 || !!row.truncated,
      };
    },
  };
}
