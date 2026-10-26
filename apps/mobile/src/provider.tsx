import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, View, Text, useColorScheme } from "react-native";
import { createMobileController } from "./native-runtime";
import type { MobileController, MobileState } from "./controller";
import { selectionSnapshot } from "./selection";
import { colors } from "./theme";
import { mobileLifecycle } from "./lifecycle";
const Context = createContext<MobileController | null>(null);
export function MobileProvider({ children }: { children: React.ReactNode }) {
  useColorScheme();
  const [controller] = useState(createMobileController);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const change = mobileLifecycle(controller, AppState.currentState);
    const subscription = AppState.addEventListener("change", (state) => {
      const visible = state === "active";
      setActive(visible);
      change(state);
    });
    return () => {
      subscription.remove();
      controller.suspend();
    };
  }, [controller]);
  return (
    <Context value={controller}>
      {children}
      {!active && (
        <View
          accessibilityViewIsModal
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: colors.background,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 24, color: colors.label }}>hikaro</Text>
        </View>
      )}
    </Context>
  );
}
/** Re-renders only when a selected field changes. `select` must depend on state alone. */
export function useMobileSelector<T extends Record<string, unknown>>(
  select: (state: MobileState) => T,
) {
  const controller = use(Context);
  if (!controller) throw Error("Mobile provider required");
  const [snapshot] = useState(() =>
    selectionSnapshot(() => controller.state, select),
  );
  const state = useSyncExternalStore(controller.subscribe, snapshot);
  return { controller, state };
}
export function useMobile() {
  const controller = use(Context);
  if (!controller) throw Error("Mobile provider required");
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.state,
  );
  return { controller, state };
}
