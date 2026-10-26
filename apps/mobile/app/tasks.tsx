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
import { useMobileSelector } from "@/provider";
import { Action, Note, confirmConnectionRemoval } from "@/ui";
import { colors, readable } from "@/theme";
import { NotificationSettings } from "@/notification-settings";
import { canReturnToTask } from "@/task-continuation";
export default function Tasks() {
  useColorScheme();
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    deviceId: s.deviceId,
    relay: s.relay,
    error: s.error,
    loading: s.loading,
    messages: s.messages,
    moreSessions: s.moreSessions,
    offset: s.offset,
    session: s.session,
    sessions: s.sessions,
    composer: s.composer,
  }));
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
            {online
              ? "已连接"
              : state.phase === "connecting" || state.phase === "restoring"
                ? "正在恢复连接 · 以下是上次内容"
                : "连接已断开 · 以下是上次内容"}
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
          <NotificationSettings />
          {(state.offset > 0 || state.moreSessions) && (
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
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
              </View>
              <View style={{ flex: 1 }}>
                <Action
                  title="下一页"
                  quiet
                  disabled={!online || state.loading || !state.moreSessions}
                  onPress={() => {
                    void controller.tasks(state.offset + 50).catch(() => {});
                  }}
                />
              </View>
            </View>
          )}
          {state.session && (
            <>
              {!online && canReturnToTask(state) && (
                <Note>离线内容可能已过时；草稿不会自动发送。</Note>
              )}
              <Action
                title={
                  online
                    ? "返回正在查看的任务"
                    : state.messages.length
                      ? "查看离线任务与草稿"
                      : "查看本机草稿"
                }
                disabled={!canReturnToTask(state)}
                onPress={() => {
                  if (canReturnToTask(controller.state)) router.push("/task");
                }}
              />
            </>
          )}
          <Action
            title="移除这台电脑的连接"
            quiet
            onPress={() => confirmConnectionRemoval(controller)}
          />
        </View>
      }
    />
  );
}
