import { Stack } from "expo-router/stack";
import { SessionProvider } from "../src/session-context";
import { StatusBar } from "expo-status-bar";
export default function Layout() {
  return (
    <SessionProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTintColor: "#c45548",
        }}
      >
        <Stack.Screen name="index" options={{ title: "Hikaro" }} />
        <Stack.Screen
          name="pair"
          options={{ title: "Pair a computer", presentation: "formSheet" }}
        />
      </Stack>
    </SessionProvider>
  );
}
