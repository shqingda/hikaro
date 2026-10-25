/** Lazy client library APIs. This module is not on the TUI startup path. */
import * as z from "zod";
import { createHash } from "node:crypto";
import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { Session } from "../../../packages/core/src/types.ts";
import { readSessionArtifact } from "../../../packages/runtime/src/session-artifacts.ts";
import { publicSession } from "../../../packages/protocol/src/index.ts";

const integer = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .parse(value ?? fallback);
import {
  modelSettingsSchema as settingsSchema,
  validateSettings,
} from "./rpc-configuration.ts";
const publicSelection = (selection: Session["modelSelection"]) =>
  selection && {
    provider: selection.provider,
    model: selection.model,
    settings: selection.settings,
  };

export async function libraryRequest(
  runtime: Runtime,
  method: string,
  p: Record<string, unknown>,
  selected: () => Promise<Session>,
): Promise<unknown> {
  switch (method) {
    case "model.capabilities": {
      if (p.baseUrl !== undefined || p.endpointCapabilities !== undefined)
        throw Error("Configure endpoints on the host");
      const provider = z.string().min(1).max(128).parse(p.provider);
      const model = z.string().min(1).max(256).parse(p.model);
      const scope = z.enum(["active", "default"]).parse(p.scope ?? "active");
      const selection =
        scope === "default"
          ? ((await runtime.providerCatalog().readDefault()) ??
            runtime.defaultSelection())
          : p.sessionId !== undefined || p.scope === "active"
            ? ((await selected()).modelSelection ?? runtime.defaultSelection())
            : runtime.defaultSelection();
      return runtime
        .providerCatalog()
        .capabilities(
          selection.provider === provider && selection.model === model
            ? selection
            : { provider, model },
        );
    }
    case "messages.search": {
      const session = await selected();
      const query = z.string().min(1).max(256).parse(p.query);
      return runtime.store.searchMessages(
        session.id,
        query,
        p.before === undefined ? undefined : integer(p.before, 0),
        Math.max(1, integer(p.limit, 20, 50)),
      );
    }
    case "workspace.current":
      return {
        id: createHash("sha256").update(runtime.options.cwd).digest("hex"),
        cwd: runtime.options.cwd,
        permissionMode: runtime.permissionMode,
        arbitraryWorkspaceSelection: false,
      };
    case "session.rename":
      return publicSession(
        await runtime.renameSession(
          (await selected()).id,
          z.string().trim().min(1).max(120).parse(p.title),
        ),
      );
    case "draft.read":
      return { text: await runtime.store.draft((await selected()).id) };
    case "draft.save":
      await runtime.store.saveDraft(
        (await selected()).id,
        z.string().max(100000).parse(p.text),
      );
      return { saved: true };
    case "model.read": {
      const session = await selected();
      const current = session.modelSelection ?? runtime.defaultSelection();
      return {
        current: publicSelection(current),
        default: publicSelection(
          (await runtime.providerCatalog().readDefault()) ??
            runtime.defaultSelection(),
        ),
        capabilities: await runtime.providerCatalog().capabilities(current),
      };
    }
    case "models.list": {
      const provider = z.string().min(1).max(128).optional().parse(p.provider);
      const query = z
        .string()
        .max(200)
        .parse(p.query ?? "")
        .toLowerCase();
      const offset = integer(p.offset, 0),
        limit = Math.max(1, integer(p.limit, 50, 100));
      const models = [
        { provider: "demo", id: "offline", name: "Offline demo" },
        ...(await runtime.providerCatalog().available(provider)),
      ];
      const filtered = models.filter(
        (m) =>
          (!provider || m.provider === provider) &&
          `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(query),
      );
      return {
        items: filtered.slice(offset, offset + limit),
        hasMore: offset + limit < filtered.length,
      };
    }
    case "model.set": {
      if (p.baseUrl !== undefined || p.endpointCapabilities !== undefined)
        throw Error("Configure endpoints on the host before selecting a model");
      const provider = z.string().min(1).max(128).parse(p.provider),
        model = z.string().min(1).max(256).parse(p.model);
      const settings =
        p.settings === undefined ? undefined : settingsSchema.parse(p.settings);
      return publicSession(
        await runtime.setModel(await selected(), provider, model, settings),
      );
    }
    case "model.default": {
      const session = await selected();
      const current = session.modelSelection ?? runtime.defaultSelection();
      if (p.baseUrl !== undefined || p.endpointCapabilities !== undefined)
        throw Error("Configure endpoints on the host");
      const provider = z
        .string()
        .min(1)
        .max(128)
        .parse(p.provider ?? current.provider);
      const model = z
        .string()
        .min(1)
        .max(256)
        .parse(p.model ?? current.model);
      const defaults =
        (await runtime.providerCatalog().readDefault()) ??
        runtime.defaultSelection();
      const scope = z.enum(["active", "default"]).parse(p.scope ?? "active");
      const base = (
        scope === "default" ? [defaults, current] : [current, defaults]
      ).find(
        (selection) =>
          selection.provider === provider && selection.model === model,
      );
      const selection = {
        provider,
        model,
        settings:
          p.settings === undefined
            ? (base?.settings ?? {})
            : settingsSchema.parse(p.settings),
        ...(base?.baseUrl ? { baseUrl: base.baseUrl } : {}),
        ...(base?.endpointCapabilities
          ? { endpointCapabilities: base.endpointCapabilities }
          : {}),
      };
      if (p.settings !== undefined) await validateSettings(runtime, selection);
      await runtime.saveDefaultSelection(selection);
      return { saved: true };
    }
    case "messages.content":
      return runtime.store.messageContent(
        (await selected()).id,
        integer(p.seq, 0),
        z
          .enum(["text", "thinking", "image", "toolCalls"])
          .parse(p.field ?? "text"),
        integer(p.offset, 0),
        Math.max(1, integer(p.limit, 65536, 65536)),
        integer(p.image, 0, 1024),
      );
    case "session.export": {
      // Stable sequence watermark and bounded Markdown pages, without a host path.
      const session = await selected();
      const through =
        p.through === undefined
          ? await runtime.store.latestSeq(session.id)
          : integer(p.through, 0);
      const after = integer(p.after, 0);
      const page = await runtime.store.messagePage(session.id, {
        after,
        limit: 1,
        bounded: true,
      });
      const item = page.items[0];
      if (!item || item.seq > through)
        return { through, after, hasMore: false, text: "" };
      const part = await runtime.store.messageContent(
        session.id,
        item.seq,
        "text",
        integer(p.offset, 0),
        32768,
      );
      return {
        through,
        after: part.nextOffset === null ? item.seq : after,
        seq: item.seq,
        nextOffset: part.nextOffset,
        hasMore:
          part.nextOffset !== null || (page.hasNewer && item.seq < through),
        text:
          (integer(p.offset, 0) === 0 ? `## ${item.message.role}\n\n` : "") +
          part.data +
          (part.nextOffset === null ? "\n\n" : ""),
      };
    }
    case "artifact.read": {
      const session = await selected();
      const ref = await runtime.store.messageContent(
        session.id,
        integer(p.seq, 0),
        "artifact",
        0,
        1,
      );
      const path = ref.data;
      // Only a host-authored tool.end reference in this session can select a file.
      const bytes = await readSessionArtifact(
        runtime.options.home!,
        session.id,
        path,
        AbortSignal.timeout(5000),
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (p.digest !== undefined && p.digest !== digest)
        throw Error("Artifact changed; restart reading explicitly");
      const offset = integer(p.offset, 0),
        end = Math.min(
          bytes.length,
          offset + Math.max(1, integer(p.limit, 49152, 49152)),
        );
      return {
        data: bytes.subarray(offset, end).toString("base64"),
        encoding: "base64",
        mimeType: path.endsWith(".json") ? "application/json" : "text/plain",
        total: bytes.length,
        digest,
        nextOffset: end < bytes.length ? end : null,
      };
    }
  }
  throw Error("Unsupported library method");
}
