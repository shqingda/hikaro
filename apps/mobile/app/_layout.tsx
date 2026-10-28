import { useColorScheme } from "react-native";
import { router } from "expo-router";
import { Action } from "@/ui";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { MobileProvider } from "@/provider";
import { NotificationResponses } from "@/notification-responses";
import { colors } from "@/theme";
export default function Layout() {
  useColorScheme();
  return (
    <MobileProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: "minimal",
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.label,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: "hikaro",
            headerRight: () => (
              <Action
                title="设置"
                quiet
                onPress={() => router.push("/settings")}
              />
            ),
          }}
        />
        <Stack.Screen
          name="tasks"
          options={{
            title: "任务",
            headerRight: () => (
              <Action
                title="设置"
                quiet
                onPress={() => router.push("/settings")}
              />
            ),
          }}
        />
        <Stack.Screen
          name="task"
          options={{
            title: "对话",
            headerRight: () => (
              <Action
                title="工具"
                quiet
                onPress={() => router.push("/tools")}
              />
            ),
          }}
        />
        <Stack.Screen name="tools" options={{ title: "任务工具" }} />
        <Stack.Screen name="settings" options={{ title: "设置" }} />
        <Stack.Screen name="message" options={{ title: "消息正文" }} />
        <Stack.Screen name="search" options={{ title: "搜索消息" }} />
        <Stack.Screen name="image" options={{ title: "消息图片" }} />
        <Stack.Screen name="changes" options={{ title: "文件差异" }} />
        <Stack.Screen name="plan" options={{ title: "计划进度" }} />
        <Stack.Screen name="background" options={{ title: "后台任务" }} />
        <Stack.Screen name="steering" options={{ title: "补充指令队列" }} />
        <Stack.Screen
          name="scan"
          options={{
            title: "扫描配对码",
            presentation: "modal",
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.label,
          }}
        />
      </Stack>
      <NotificationResponses />
    </MobileProvider>
  );
}
