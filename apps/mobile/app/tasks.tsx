import { useEffect } from "react";
import {
  FlatList,
  View,
  Text,
  Pressable,
  useColorScheme,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
export default function Tasks() {
  useColorScheme();
  const { controller, state } = useMobile();
  const online = state.phase === "connected";
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
  }, [state.phase]);
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 24, gap: 16, paddingBottom: 48 }}
      style={{ backgroundColor: colors.background }}
      data={state.sessions}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View style={{ gap: 14, marginBottom: 12 }}>
          <Text
            style={{ fontSize: 13, fontWeight: "600", color: colors.secondary }}
          >
            {online ? "已连接" : "连接已断开 · 以下是上次内容"}
          </Text>
          {state.relay && <Note>{state.relay}</Note>}
          {state.error && <Note error>{state.error}</Note>}
          {state.loading && <ActivityIndicator />}
          <Action
            title={online ? "刷新任务" : "重新连接"}
            quiet
            onPress={() => {
              void (
                online ? controller.tasks(state.offset) : controller.restore()
              ).catch(() => {});
            }}
          />
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`查看任务 ${readable(item.title)}`}
          disabled={!online || state.loading}
          onPress={() => {
            void controller
              .select(item.id)
              .then(() => {
                router.push("/task");
              })
              .catch(() => {});
          }}
          style={({ pressed }) => ({
            padding: 20,
            gap: 10,
            borderRadius: 18,
            borderCurve: "continuous",
            backgroundColor: colors.panel,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text
            style={{ fontSize: 19, fontWeight: "500", color: colors.label }}
          >
            {readable(item.title)}
          </Text>
          <Text selectable style={{ fontSize: 12, color: colors.secondary }}>
            {item.id.slice(0, 8)} ·{" "}
            {new Date(item.createdAt).toLocaleDateString()}
          </Text>
        </Pressable>
      )}
      ListEmptyComponent={
        !state.loading && online ? (
          <View style={{ gap: 14, paddingVertical: 20 }}>
            <Text style={{ fontSize: 21, color: colors.label }}>
              还没有可查看的任务
            </Text>
            <Note>请先在电脑上允许这台手机查看任务，再点刷新。</Note>
            <Text selectable style={{ fontSize: 12, color: colors.secondary }}>
              设备 ID：{state.deviceId}
            </Text>
          </View>
        ) : undefined
      }
      ListFooterComponent={
        <View style={{ gap: 12, marginTop: 20 }}>
          {(state.offset > 0 || state.moreSessions) && (
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Action
                title="上一页"
                quiet
                disabled={!online || state.loading || state.offset === 0}
                onPress={() => {
                  void controller
                    .tasks(Math.max(0, state.offset - 50))
                    .catch(() => {});
                }}
              />
              <Action
                title="下一页"
                quiet
                disabled={!online || state.loading || !state.moreSessions}
                onPress={() => {
                  void controller.tasks(state.offset + 50).catch(() => {});
                }}
              />
            </View>
          )}
          {state.session && (
            <Action
              title="返回正在查看的任务"
              disabled={!online}
              onPress={() => router.push("/task")}
            />
          )}
          <Action
            title="移除这台电脑的连接"
            quiet
            onPress={() => {
              void controller.forget().catch(() => {});
            }}
          />
        </View>
      }
    />
  );
}
