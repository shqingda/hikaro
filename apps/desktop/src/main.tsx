import React, {
  memo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import {
  SessionController,
  type MessageRow,
} from "../../../packages/client-state/src/index.ts";
import brandIcon from "../../../brand/hikaro-icon-transparent.png";
import "./style.css";
declare global {
  interface Window {
    hikaro: {
      connect(): Promise<{ cwd: string }>;
      workspace(): Promise<{ cwd: string } | undefined>;
      openExternal(url: string): Promise<void>;
      command(method: string, params?: Record<string, unknown>): Promise<any>;
      subscribe(fn: (message: any) => void): () => void;
    };
  }
}
const markdownComponents = {
  a: ({ href, children }: any) => (
    <a
      href={href}
      onClick={(event: React.MouseEvent) => {
        event.preventDefault();
        if (href && /^https?:\/\//.test(href))
          void window.hikaro.openExternal(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  img: ({ alt }: any) => (
    <span className="image-placeholder">
      {alt ? `Image: ${alt}` : "Image attachment"}
    </span>
  ),
};
const MessageView = memo(function MessageView({ row }: { row: MessageRow }) {
  const message = row.message;
  if (message.role === "tool")
    return (
      <details className="tool" data-seq={row.seq}>
        <summary>
          {message.name ?? "Tool result"}
          {message.isError ? " · failed" : ""}
        </summary>
        <pre>{message.text}</pre>
      </details>
    );
  return (
    <article className={message.role} data-seq={row.seq}>
      <div className="role">{message.role === "user" ? "You" : "Hikaro"}</div>
      <div
        className={
          message.role === "user" ? "message user-text" : "message markdown"
        }
      >
        {message.role === "assistant" ? (
          <Markdown components={markdownComponents} skipHtml>
            {message.text}
          </Markdown>
        ) : (
          message.text
        )}
      </div>
    </article>
  );
});
function App() {
  const cwdRef = useRef("");
  const [controller] = useState(
    () =>
      new SessionController(
        {
          request: (method, params) => window.hikaro.command(method, params),
          subscribe: (listener) => window.hikaro.subscribe(listener),
        },
        (session) =>
          localStorage.setItem(`hikaro.session.${cwdRef.current}`, session.id),
      ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [cwd, setCwd] = useState("");
  const [draft, setDraft] = useState("");
  const [follow, setFollow] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const preservingScroll = useRef(false);
  const ready =
    state.status === "connected" && !state.recovering && !!state.session;
  const locked =
    state.busy || state.recovering || state.actionPending || !ready;
  const connect = async () => {
    try {
      const host = await window.hikaro.connect();
      cwdRef.current = host.cwd;
      setCwd(host.cwd);
      await controller.recover(
        localStorage.getItem(`hikaro.session.${host.cwd}`) ?? undefined,
      );
    } catch (error) {
      controller.setError(error);
    }
  };
  useEffect(() => {
    void connect();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    if (follow && !preservingScroll.current && !state.hasNewer)
      end.current?.scrollIntoView({ behavior: "instant" });
  }, [state.rows, state.stream, follow, state.hasNewer]);
  useEffect(() => {
    const element = input.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(200, element.scrollHeight)}px`;
    }
  }, [draft]);
  const send = async () => {
    const text = draft.trim();
    if (await controller.send(text)) {
      setDraft((value) => (value.trim() === text ? "" : value));
      setFollow(true);
      input.current?.focus();
    }
  };
  const history = async () => {
    const element = transcript.current;
    const height = element?.scrollHeight ?? 0;
    const top = element?.scrollTop ?? 0;
    preservingScroll.current = true;
    setFollow(false);
    await controller.history();
    requestAnimationFrame(() => {
      if (element) element.scrollTop = top + element.scrollHeight - height;
      preservingScroll.current = false;
    });
  };
  const latest = async () => {
    await controller.history(false);
    setFollow(true);
  };
  const changeWorkspace = async () => {
    try {
      const value = await window.hikaro.workspace();
      if (!value) return;
      cwdRef.current = value.cwd;
      setCwd(value.cwd);
      setDraft("");
      await controller.recover(
        localStorage.getItem(`hikaro.session.${value.cwd}`) ?? undefined,
      );
      setFollow(true);
    } catch (error) {
      controller.setError(error);
    }
  };
  return (
    <div className="shell">
      <aside aria-label="Workspace">
        <div className="traffic-space" />
        <div className="brand">
          <img src={brandIcon} alt="" width={36} height={36} />
          hikaro
        </div>
        <button
          className="new"
          disabled={locked}
          onClick={() => {
            setFollow(true);
            void controller.select();
          }}
        >
          ＋ New session
        </button>
        <nav aria-label="Sessions">
          {state.sessions.map((session) => (
            <button
              key={session.id}
              disabled={locked}
              aria-current={
                session.id === state.session?.id ? "page" : undefined
              }
              className={session.id === state.session?.id ? "selected" : ""}
              title={session.title}
              onClick={() => {
                setFollow(true);
                void controller.select(session.id);
              }}
            >
              {session.title}
            </button>
          ))}
          {state.moreSessions && (
            <button
              className="subtle"
              onClick={() =>
                void controller
                  .refreshSessions(true)
                  .catch((error) => controller.setError(error))
              }
            >
              More sessions
            </button>
          )}
        </nav>
        <button
          className="workspace"
          disabled={locked}
          title={cwd}
          onClick={() => void changeWorkspace()}
        >
          <span>{cwd.split("/").at(-1) || "Choose workspace"}</span>
          <span aria-hidden="true">⌄</span>
        </button>
      </aside>
      <main>
        <header>
          <span className="session-title">
            {state.session?.title ?? "New session"}
          </span>
          <span className="state" role="status">
            {state.status !== "connected"
              ? "Disconnected"
              : state.recovering
                ? "Restoring…"
                : state.approvals.length
                  ? "Needs your input"
                  : state.busy
                    ? "Working"
                    : "Ready"}
          </span>
        </header>
        <section
          ref={transcript}
          className="transcript"
          aria-label="Conversation"
          onScroll={(event) => {
            if (!preservingScroll.current) {
              const el = event.currentTarget;
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }
          }}
        >
          {state.hasOlder && (
            <button
              className="history-button"
              disabled={state.historyPending || !ready}
              onClick={() => void history()}
            >
              {state.historyPending ? "Loading…" : "Load earlier messages"}
            </button>
          )}
          {state.rows.length === 0 && !state.stream ? (
            <div className="empty">
              <img
                className="large-mark"
                src={brandIcon}
                alt="Hikaro"
                width={68}
                height={68}
              />
              <h1>New session</h1>
              <p>Ask about this project, or describe a change.</p>
              <button
                disabled={!ready}
                onClick={() => {
                  setDraft("Inspect this project and explain its structure.");
                  input.current?.focus();
                }}
              >
                Explore this project
              </button>
            </div>
          ) : (
            state.rows.map((row) => <MessageView key={row.seq} row={row} />)
          )}
          {state.stream && !state.hasNewer && (
            <article className="stream">
              <div className="role">
                Hikaro{state.busy ? " · writing" : " · partial response"}
              </div>
              {state.streamTruncated && (
                <p className="subtle">
                  Showing the latest part. The complete response will be
                  available when the task finishes.
                </p>
              )}
              <div className="message user-text">{state.stream}</div>
            </article>
          )}
          <div ref={end} />
        </section>
        <footer>
          {(!follow || state.hasNewer) && (
            <button className="latest-button" onClick={() => void latest()}>
              Return to latest ↓
            </button>
          )}
          {state.error && (
            <div role="alert" className="error">
              <span>{state.error}</span>
              <button
                aria-label="Dismiss error"
                onClick={() => controller.clearError()}
              >
                ×
              </button>
            </div>
          )}
          {state.status !== "connected" && (
            <button className="reconnect" onClick={() => void connect()}>
              Reconnect
            </button>
          )}
          {state.approvals.map((approval) => (
            <div
              className="approval"
              key={approval.id}
              role="region"
              aria-label="Permission requested"
            >
              <strong>Permission requested</strong>
              <p>{approval.reason}</p>
              <details>
                <summary>{approval.tool} details</summary>
                <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
              </details>
              <div>
                <button
                  disabled={!ready || state.actionPending}
                  onClick={() => void controller.respond(approval.id, false)}
                >
                  Deny
                </button>
                <button
                  className="primary"
                  disabled={!ready || state.actionPending}
                  onClick={() => void controller.respond(approval.id, true)}
                >
                  Allow once
                </button>
              </div>
            </div>
          ))}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={input}
              aria-label="Message Hikaro"
              placeholder={
                state.busy
                  ? "Add guidance for the current task…"
                  : "What would you like to build?"
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void send();
                }
                if (event.key === "Escape" && state.busy) {
                  event.preventDefault();
                  void controller.cancel();
                }
              }}
            />
            <div className="composer-bar">
              <span>Shift + Enter for a new line</span>
              <div className="composer-actions">
                {state.busy && (
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => void controller.cancel()}
                  >
                    Stop
                  </button>
                )}
                <button
                  className="primary"
                  disabled={!draft.trim() || !ready || state.actionPending}
                >
                  {state.actionPending
                    ? "Sending…"
                    : state.busy
                      ? "Add guidance"
                      : "Send ↑"}
                </button>
              </div>
            </div>
          </form>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
