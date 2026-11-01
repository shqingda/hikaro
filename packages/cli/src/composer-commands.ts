import type { HikaroView } from "../../tui/src/index.ts";

const attachUsage =
  'Use /attach PATH, then add your question and send. You can also type @file or @"path with spaces" directly.';

/** /attach for both clients. Quoted or shell-escaped drag-and-drop paths are accepted. */
export async function attachPath(view: HikaroView, arg: string) {
  if (!arg.trim()) return attachUsage;
  const { attachmentReference } =
    await import("../../runtime/src/attachments.ts");
  view.editor.setText(attachmentReference(arg) + " ");
  return "Attachment added. Add your question and press Enter.";
}

/** /paste-image for both clients; a changed draft or session keeps the file but not the edit. */
export async function pasteClipboardImage(
  view: HikaroView,
  unchanged: () => boolean,
) {
  const draft = view.editor.getExpandedText();
  const [{ saveClipboardImage }, { attachmentReference }] = await Promise.all([
    import("../../runtime/src/clipboard-image.ts"),
    import("../../runtime/src/attachments.ts"),
  ]);
  const path = await saveClipboardImage();
  if (!unchanged() || view.editor.getExpandedText() !== draft)
    return `Input changed; clipboard image saved at ${path}. Use /attach PATH to add it when ready.`;
  view.editor.setText(attachmentReference(path) + " ");
  return "Clipboard image attached. Add your question and press Enter. The private temporary file is retained for draft recovery.";
}

/** Local attachment preview behind an explicit read approval. Nothing reaches the model. */
export async function previewWithApproval(
  view: HikaroView,
  options: { cwd: string; sessionId: string; model: string },
  path: string,
  signal: AbortSignal,
) {
  const { previewAttachment } =
    await import("../../runtime/src/attachments.ts");
  return previewAttachment(path, {
    cwd: options.cwd,
    signal,
    approve: (file) =>
      view.approve(
        {
          id: crypto.randomUUID(),
          sessionId: options.sessionId,
          tool: "preview_attachment",
          arguments: { path: file.path },
          reason: `Read ${file.path} for local preview only; nothing is sent to ${options.model}`,
          capability: { kind: "file", path: file.path, write: false },
        },
        signal,
      ),
  });
}
