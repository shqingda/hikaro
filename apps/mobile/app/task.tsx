import { useEffect } from "react";
import {
  FlatList,
  View,
  Text,
  useColorScheme,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
const status: Record<string, string> = {
  idle: "尚未运行",
  running: "电脑正在执行",
  completed: "已完成",
  failed: "运行失败",
  cancelled: "已停止",
  unknown: "结果待确认",
};
export default function Task() {
  useColorScheme();
  const { controller, state } = useMobile();
  const online = state.phase === "connected";
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (online && !state.session) router.replace("/tasks");
  }, [state.phase, online, state.session]);
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 24, gap: 24, paddingBottom: 48 }}
      style={{ backgroundColor: colors.background }}
      data={state.messages}
      keyExtractor={(item) => String(item.seq)}
      ListHeaderComponent={
        <View style={{ gap: 14, marginBottom: 8 }}>
          <Text
            accessibilityRole="header"
            selectable
            style={{
              fontSize: 26,
              lineHeight: 34,
              fontWeight: "500",
              color: colors.label,
            }}
          >
            {readable(state.session?.title ?? "正在恢复任务")}
          </Text>
          <Note>
            {online
              ? (status[state.runStatus] ?? "状态待确认")
              : "离线快照 · 状态可能已变化"}
          </Note>
          <Note>本页只读。发送、停止和审批请回到电脑。</Note>
          {state.unknown > 0 && (
            <Note>
              有未确认的会话切换记录。当前内容以电脑返回的状态为准，没有重新发送操作。
            </Note>
          )}
          {state.error && <Note error>{state.error}</Note>}
          {state.loading && <ActivityIndicator />}
          {state.hasOlder && (
            <Action
              title="更早的消息"
              disabled={!online || state.loading}
              quiet
              onPress={() => {
                void controller.history("older").catch(() => {});
              }}
            />
          )}
        </View>
      }
      renderItem={({ item }) => (
        <View style={{ gap: 10, paddingVertical: 8 }}>
          <Text style={{ color: colors.secondary, fontSize: 12 }}>
            {item.message.role === "user"
              ? "你的要求"
              : item.message.role === "assistant"
                ? "Hikaro"
                : "工具记录"}
          </Text>
          <Text
            selectable
            numberOfLines={
              (item.message.textLength ?? 0) > item.message.text.length
                ? 12
                : undefined
            }
            style={{ color: colors.label, fontSize: 16, lineHeight: 25 }}
          >
            {readable(item.message.text)}
          </Text>
          {!!item.message.imageCount && (
            <Note>
              包含 {item.message.imageCount} 张图片，图片浏览将在后续阶段开放。
            </Note>
          )}
          {item.message.textLength !== undefined &&
            item.message.textLength > item.message.text.length && (
              <View style={{ gap: 10 }}>
                <Note>当前显示长消息预览，可以按段阅读全文。</Note>
                <Action
                  title="阅读全文"
                  quiet
                  disabled={!online || state.contentLoading}
                  onPress={() => {
                    void controller.readMessage(item.seq).catch(() => {});
                    router.push("/message");
                  }}
                />
              </View>
            )}
        </View>
      )}
      ListEmptyComponent={
        !state.loading ? (
          <Note>
            {state.session
              ? "这项任务还没有消息。"
              : "请返回任务列表选择一项任务。"}
          </Note>
        ) : undefined
      }
      ListFooterComponent={
        <View style={{ gap: 18, marginTop: 16 }}>
          {state.stream && !state.hasNewer && (
            <>
              <Text style={{ fontSize: 12, color: colors.secondary }}>
                正在输出
              </Text>
              <Text
                selectable
                style={{ fontSize: 16, lineHeight: 25, color: colors.label }}
              >
                {readable(state.stream)}
              </Text>
              {state.streamTruncated && (
                <Note>显示最近一段输出，完整结果以电脑上的任务历史为准。</Note>
              )}
            </>
          )}
          {state.hasNewer && (
            <Action
              title="较新的消息"
              disabled={!online || state.loading}
              quiet
              onPress={() => {
                void controller.history("newer").catch(() => {});
              }}
            />
          )}
          <Action
            title={online ? "恢复最新内容" : "重新连接"}
            quiet
            disabled={state.loading}
            onPress={() => {
              void (
                online ? controller.history("latest") : controller.restore()
              ).catch(() => {});
            }}
          />
        </View>
      }
    />
  );
}
