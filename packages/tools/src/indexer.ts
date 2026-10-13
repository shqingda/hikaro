import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runProcess, resolvePath } from "./index.ts";
import type { Plugin, ToolContext } from "../../core/src/types.ts";
export type Chunk = {
  id: string;
  workspace: string;
  path: string;
  line: number;
  text: string;
  hash: string;
  vector?: number[];
  model?: string;
};
export interface IndexStore {
  indexReplace(workspace: string, path: string, chunks: Chunk[]): Promise<void>;
  indexFiles(workspace: string): Promise<Array<{ path: string; hash: string }>>;
  indexPrune(workspace: string, paths: string[]): Promise<void>;
  indexSearch(
    workspace: string,
    query: string,
    vector?: number[],
    model?: string,
  ): Promise<Chunk[]>;
}
export const EmbeddingConfig = z.object({
  url: z.url(),
  model: z.string(),
  apiKeyEnv: z.string().optional(),
});
export function indexPlugin(
  store: IndexStore,
  embedding?: z.infer<typeof EmbeddingConfig>,
): Plugin {
  return {
    id: "hikaro.index",
    apiVersion: 1,
    setup(host) {
      const embed = async (texts: string[], ctx: ToolContext) => {
        if (!embedding) return undefined;
        const key = embedding.apiKeyEnv
          ? process.env[embedding.apiKeyEnv]
          : undefined;
        const response = await fetch(embedding.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({ model: embedding.model, input: texts }),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
        });
        if (!response.ok)
          throw Error(`Embedding provider returned ${response.status}`);
        const body = (await response.json()) as any;
        const data = (body.data as any[])
          ?.sort((a, b) => a.index - b.index)
          .map((row) => row.embedding);
        if (
          !Array.isArray(data) ||
          data.length !== texts.length ||
          data.some(
            (v) =>
              !Array.isArray(v) ||
              !v.length ||
              v.length > 4096 ||
              v.some((n) => typeof n !== "number" || !Number.isFinite(n)),
          )
        )
          throw Error("Invalid embedding response");
        return data as number[][];
      };
      host.registerTool({
        name: "index_codebase",
        description:
          "Build or refresh an optional local search index. Respects ignore files, caps 500 files / 2000 chunks, and excludes common secret/binary files. Configured embeddings send chunks to the selected provider only after approval.",
        schema: z.object({}),
        async execute(_, ctx) {
          if (
            embedding &&
            !(await ctx.approve(
              `Send indexed code chunks to embedding endpoint ${embedding.url}`,
            ))
          )
            throw Error("Permission denied");
          const files = await runProcess(
            "rg",
            [
              "--files",
              "-g",
              "!.env*",
              "-g",
              "!*.pem",
              "-g",
              "!*.key",
              "-g",
              "!pnpm-lock.yaml",
              "-g",
              "!package-lock.json",
            ],
            ctx,
            { limit: 200000 },
          );
          if (files.isError) throw Error(files.text);
          const paths = files.text.split("\n").filter(Boolean);
          if (paths.length > 500)
            throw Error(
              "Index quota exceeded: narrow the workspace or ignore generated files (maximum 500 files).",
            );
          const previous = new Map(
            (await store.indexFiles(ctx.cwd)).map((f) => [f.path, f.hash]),
          );
          let count = 0,
            updated = 0;
          for (const path of paths) {
            ctx.signal.throwIfAborted();
            const target = await resolvePath(ctx.cwd, path);
            if (!target.inside) continue;
            if ((await stat(target.path)).size > 256000) continue;
            const text = await readFile(target.path, "utf8");
            if (text.includes("\0")) continue;
            const hash = createHash("sha256").update(text).digest("hex");
            const lines = text.split("\n");
            const chunks: Chunk[] = [];
            for (let i = 0; i < lines.length; i += 60) {
              if (++count > 2000)
                throw Error("Index quota exceeded: maximum 2000 chunks");
              chunks.push({
                id: createHash("sha256")
                  .update(ctx.cwd + "\0" + path + "\0" + i)
                  .digest("hex"),
                workspace: ctx.cwd,
                path,
                line: i + 1,
                text: lines
                  .slice(i, i + 80)
                  .join("\n")
                  .slice(0, 12000),
                hash,
              });
            }
            if (previous.get(path) === hash) continue;
            if (embedding) {
              for (let offset = 0; offset < chunks.length; offset += 16) {
                const batch = chunks.slice(offset, offset + 16);
                const vectors = await embed(
                  batch.map((c) => c.text),
                  ctx,
                );
                batch.forEach((chunk, i) => {
                  chunk.vector = vectors![i];
                  chunk.model = embedding.model;
                });
              }
            }
            await store.indexReplace(ctx.cwd, path, chunks);
            updated++;
          }
          await store.indexPrune(ctx.cwd, paths);
          return {
            text: `Indexed ${count} chunks; updated ${updated} files. ${embedding ? "Hybrid keyword/vector" : "Keyword"} search available.`,
          };
        },
      });
      host.registerTool({
        name: "semantic_search",
        description:
          "Search the local code index with source paths and line numbers. Rejects stale results. Run index_codebase first.",
        schema: z.object({ query: z.string().min(1).max(2000) }),
        async execute({ query }, ctx) {
          if (
            embedding &&
            !(await ctx.approve(
              `Send search query to embedding endpoint ${embedding.url}`,
            ))
          )
            throw Error("Permission denied");
          const vector = (await embed([query], ctx))?.[0];
          const matches = await store.indexSearch(
            ctx.cwd,
            query,
            vector,
            embedding?.model,
          );
          const fresh: Chunk[] = [];
          for (const hit of matches) {
            try {
              const target = await resolvePath(ctx.cwd, hit.path);
              if (!target.inside) continue;
              const text = await readFile(target.path, "utf8");
              if (createHash("sha256").update(text).digest("hex") === hit.hash)
                fresh.push(hit);
            } catch {}
          }
          return {
            text:
              fresh.map((h) => `${h.path}:${h.line}\n${h.text}`).join("\n\n") ||
              "No current results. Refresh the index if files changed.",
            data: fresh.map(({ vector, ...rest }) => rest),
          };
        },
      });
    },
  };
}
