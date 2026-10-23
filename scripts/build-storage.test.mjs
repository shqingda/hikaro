import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { copyStorageWorker } from "./build-storage.mjs";

test(
  "copied storage worker starts without the source tree and persists question drafts",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hikaro-storage-build-"));
    let worker;
    t.after(async () => {
      await worker?.terminate();
      await rm(directory, { recursive: true, force: true });
    });
    await copyStorageWorker(directory);
    worker = new Worker(join(directory, "worker.mjs"), {
      workerData: { path: ":memory:" },
    });
    let id = 0;
    const request = async (method, args = {}) => {
      const response = once(worker, "message");
      const expectedId = ++id;
      worker.postMessage({ id: expectedId, method, args });
      const [frame] = await response;
      assert.equal(frame.id, expectedId);
      assert.equal(frame.error, undefined);
      return frame.result;
    };
    const session = await request("createSession", { cwd: directory });
    const identity = {
      id: "build-question",
      sessionId: session.id,
      scope: "local:build",
    };
    await request("saveQuestion", {
      question: {
        ...identity,
        executionSessionId: session.id,
        hostInstanceId: "build-host",
        questions: [{ id: "detail", question: "Details?" }],
      },
    });
    const draft = {
      answers: {},
      inputs: { detail: "未提交的打包验证🌅" },
      position: { kind: "input", questionId: "detail" },
    };
    assert.deepEqual(
      await request("saveQuestionDraft", {
        ...identity,
        workspace: directory,
        expectedRevision: 0,
        draft,
      }),
      { revision: 1 },
    );
    assert.deepEqual(
      await request("questionDraft", {
        ...identity,
        workspace: directory,
      }),
      { revision: 1, draft },
    );
    assert.equal((await request("pendingQuestions", identity)).length, 1);
    await request("close");
  },
);
