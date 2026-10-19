import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, View, Text, useColorScheme } from "react-native";
import { createMobileController } from "./native-runtime";
import type { MobileController } from "./controller";
import { colors } from "./theme";
const Context = createContext<MobileController | null>(null);
export function MobileProvider({ children }: { children: React.ReactNode }) {
  useColorScheme();
  const [controller] = useState(createMobileController);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    if (AppState.currentState === "active") void controller.restore();
    const subscription = AppState.addEventListener("change", (state) => {
      const visible = state === "active";
      setActive(visible);
      if (visible) void controller.restore();
      else controller.suspend();
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
export function useMobile() {
  const controller = use(Context);
  if (!controller) throw Error("Mobile provider required");
  const state = useSyncExternalStore(
    controller.subscribe,
    () => controller.state,
  );
  return { controller, state };
}
