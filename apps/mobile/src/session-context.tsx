import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  SessionController,
  type ClientState,
} from "../../../packages/client-state/src/index.ts";
import type { RemoteClient } from "../../../packages/remote/src/client.ts";
import { connection } from "./connection";

const empty: ClientState = {
  status: "unpaired",
  recovering: false,
  sessions: [],
  moreSessions: false,
  rows: [],
  hasOlder: false,
  hasNewer: false,
  stream: "",
  streamTruncated: false,
  busy: false,
  approvals: [],
  actionPending: false,
  historyPending: false,
  error: "",
};
const noSubscription = () => () => {};
const emptySnapshot = () => empty;
type ContextValue = {
  controller?: SessionController;
  client?: RemoteClient;
  error: string;
  refresh(): Promise<void>;
};
const Context = createContext<ContextValue>({
  error: "",
  refresh: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<SessionController>();
  const [client, setClient] = useState<RemoteClient>();
  const [error, setError] = useState("");
  const current = useRef<{
    client?: RemoteClient;
    controller?: SessionController;
  }>({});
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    try {
      const next = await connection();
      const saved = await SecureStore.getItemAsync("hikaro.session");
      if (run !== generation.current) return;
      if (next === current.current.client && current.current.controller) {
        next?.connect();
        return;
      }
      current.current.controller?.dispose();
      const view = next
        ? new SessionController(next, (session) => {
            void SecureStore.setItemAsync("hikaro.session", session.id).catch(
              (e) => setError(String(e)),
            );
          })
        : undefined;
      view?.setPreferredSession(saved ?? undefined);
      current.current = { client: next, controller: view };
      setController(view);
      setClient(next);
      setError("");
      if (AppState.currentState === "active") next?.connect();
    } catch (error) {
      if (run === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") current.current.client?.connect();
      else current.current.client?.close();
    });
    return () => {
      generation.current++;
      subscription.remove();
      current.current.controller?.dispose();
      current.current.client?.close();
    };
  }, [refresh]);
  return (
    <Context value={{ controller, client, error, refresh }}>{children}</Context>
  );
}
export function useSession() {
  const context = use(Context);
  const state = useSyncExternalStore(
    context.controller?.subscribe ?? noSubscription,
    context.controller?.getSnapshot ?? emptySnapshot,
  );
  return { ...context, state };
}
