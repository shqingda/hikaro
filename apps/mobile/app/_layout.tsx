import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { MobileProvider } from "@/provider";
import { NotificationResponses } from "@/notification-responses";
import { colors } from "@/theme";
export default function Layout() {
  return (
    <MobileProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
        <Stack.Screen
          name="index"
          options={{ title: "连接", headerLargeTitleEnabled: true }}
        />
        <Stack.Screen
          name="tasks"
          options={{ title: "任务", headerLargeTitleEnabled: true }}
        />
        <Stack.Screen name="task" options={{ title: "任务详情" }} />
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
