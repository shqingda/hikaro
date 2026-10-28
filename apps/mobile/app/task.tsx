import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  View,
  Text,
  useColorScheme,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "expo-router/react-navigation";
import { router } from "expo-router";
import { useMobileSelector } from "@/provider";
import type { MobileController, MobileMessage } from "@/controller";
import { Action, Note, EmptyState } from "@/ui";
import { colors, readable } from "@/theme";
import { TaskActions } from "@/task-actions";
import { Composer } from "@/composer-view";
const status: Record<string, string> = {
  idle: "尚未运行",
  running: "电脑正在执行",
  completed: "已完成",
  failed: "运行失败",
  cancelled: "已停止",
  unknown: "结果待确认",
};
// Stream deltas arrive every frame; only this footer piece re-renders for them.
function StreamPreview() {
  const { state } = useMobileSelector((s) => ({
    stream: s.stream,
    streamTruncated: s.streamTruncated,
    hasNewer: s.hasNewer,
  }));
  if (!state.stream || state.hasNewer) return null;
  return (
    <>
      <Text style={{ fontSize: 12, color: colors.secondary }}>正在输出</Text>
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
  );
}
const MessageRow = memo(function MessageRow({
  item,
  controller,
  online,
  contentLoading,
  canImages,
}: {
  item: MobileMessage;
  controller: MobileController;
  online: boolean;
  contentLoading: boolean;
  canImages: boolean;
}) {
  useColorScheme();
  const [expanded, setExpanded] = useState(false);
  const tool = item.message.role === "tool";
  const user = item.message.role === "user";
  return (
    <View
      style={{
        gap: 8,
        padding: user || tool ? 16 : 0,
        paddingVertical: 16,
        marginLeft: user ? 32 : 0,
        borderRadius: 16,
        backgroundColor: user || tool ? colors.panel : "transparent",
      }}
    >
      <Text style={{ color: colors.secondary, fontSize: 12 }}>
        {item.message.role === "user"
          ? "你的要求"
          : item.message.role === "assistant"
            ? "Hikaro"
            : item.message.role === "tool"
              ? `工具记录${item.message.name ? ` · ${readable(item.message.name)}` : ""}${item.message.isError ? " · 失败" : ""}`
              : "系统记录"}
      </Text>
      {tool && (
        <Action
          title={expanded ? "收起工具输出" : "展开工具输出"}
          quiet
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {(!tool || expanded) && (
        <>
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
          {!!item.message.toolCalls?.length && (
            <View style={{ gap: 10 }}>
              <Note>
                工具调用名称预览：
                {item.message.toolCalls
                  .map((call) => readable(call.name))
                  .join("、")}
                。完整调用参数可按需查看。
              </Note>
              <Action
                title="查看工具调用"
                quiet
                disabled={!online || contentLoading}
                onPress={() => {
                  void controller
                    .readMessage(item.seq, 0, "toolCalls")
                    .catch(() => {});
                  router.push("/message");
                }}
              />
            </View>
          )}
          {!!item.message.imageCount && (
            <Action
              title={`查看 ${item.message.imageCount} 张图片`}
              quiet
              disabled={!online || !canImages}
              onPress={() => {
                void controller.inspection
                  .readImage(item.seq, 0, item.message.imageCount!)
                  .catch(() => {});
                router.push("/image");
              }}
            />
          )}
          {item.message.textLength !== undefined &&
            item.message.textLength > item.message.text.length && (
              <View style={{ gap: 10 }}>
                <Note>当前显示长消息预览，可以按段阅读全文。</Note>
                <Action
                  title="阅读全文"
                  quiet
                  disabled={!online || contentLoading}
                  onPress={() => {
                    void controller.readMessage(item.seq).catch(() => {});
                    router.push("/message");
                  }}
                />
              </View>
            )}
        </>
      )}
    </View>
  );
});
export default function Task() {
  useColorScheme();
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    session: s.session,
    runStatus: s.runStatus,
    inspection: s.inspection,
    unknown: s.unknown,
    error: s.error,
    loading: s.loading,
    contentLoading: s.contentLoading,
    hasOlder: s.hasOlder,
    hasNewer: s.hasNewer,
    messages: s.messages,
  }));

  const online = state.phase === "connected";
  const contentLoading = state.contentLoading;
  const canImages = state.inspection.canImages;
  const renderItem = useCallback(
    ({ item }: { item: MobileMessage }) => (
      <MessageRow
        item={item}
        controller={controller}
        online={online}
        contentLoading={contentLoading}
        canImages={canImages}
      />
    ),
    [controller, online, contentLoading, canImages],
  );
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (online && !state.session) router.replace("/tasks");
  }, [state.phase, online, state.session]);
  const headerHeight = useHeaderHeight();
  const list = useRef<FlatList<MobileMessage>>(null);
  const follow = useRef(!state.hasNewer);
  const contentHeight = useRef(0);
  const [away, setAway] = useState(false);
  const interacting = useRef(false);
  useEffect(() => {
    follow.current = !state.hasNewer;
    setAway(false);
  }, [state.session?.id]);
  const latest = async () => {
    if (state.hasNewer) {
      if (!online) return;
      try {
        await controller.history("latest");
      } catch {
        return;
      }
    }
    interacting.current = false;
    follow.current = true;
    setAway(false);
    list.current?.scrollToOffset({
      offset: contentHeight.current,
      animated: true,
    });
  };
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={headerHeight}
      >
        <View
          style={{
            paddingHorizontal: 20,
            paddingBottom: 8,
            gap: 4,
            borderBottomWidth: 0.5,
            borderBottomColor: colors.separator,
          }}
        >
          <Text
            numberOfLines={2}
            accessibilityRole="header"
            style={{
              fontSize: 18,
              lineHeight: 26,
              fontWeight: "600",
              color: colors.label,
            }}
          >
            {readable(state.session?.title ?? "正在恢复任务")}
          </Text>
          <Note>
            {online
              ? (status[state.runStatus] ?? "状态待确认")
              : "离线快照 · 草稿不会自动发送"}
          </Note>
        </View>
        <ScrollView
          style={{ maxHeight: 180, flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 4 }}
          keyboardShouldPersistTaps="handled"
        >
          <TaskActions />
          {state.unknown > 0 && (
            <Note>有未确认的操作，请在工具中核对回执，不会自动重发。</Note>
          )}
          {state.error && <Note error>{state.error}</Note>}
        </ScrollView>
        <FlatList
          ref={list}
          key={state.session?.id}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, gap: 8, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          scrollEventThrottle={32}
          onLayout={() => {
            if (follow.current && !state.hasNewer)
              requestAnimationFrame(() =>
                list.current?.scrollToOffset({
                  offset: contentHeight.current,
                  animated: false,
                }),
              );
          }}
          onScrollBeginDrag={() => {
            interacting.current = true;
            follow.current = false;
          }}
          onScroll={({ nativeEvent: e }) => {
            if (!interacting.current) return;
            const near =
              e.contentSize.height -
                e.layoutMeasurement.height -
                e.contentOffset.y <
              64;
            follow.current = near && !state.hasNewer;
            setAway(!near);
          }}
          onContentSizeChange={(_width, height) => {
            contentHeight.current = height;
            if (follow.current && !state.hasNewer)
              list.current?.scrollToOffset({
                offset: contentHeight.current,
                animated: false,
              });
          }}
          data={state.messages}
          keyExtractor={(item) => String(item.seq)}
          renderItem={renderItem}
          ListHeaderComponent={
            <View>
              {state.loading && (
                <ActivityIndicator accessibilityLabel="正在读取消息" />
              )}
              {state.hasOlder && (
                <Action
                  title="更早的消息"
                  quiet
                  disabled={!online || state.loading}
                  onPress={() => {
                    follow.current = false;
                    void controller.history("older").catch(() => {});
                  }}
                />
              )}
            </View>
          }
          ListEmptyComponent={
            !state.loading ? (
              <EmptyState
                title={online ? "从这里继续对话" : "暂无离线消息"}
                detail={
                  online
                    ? "输入要求并明确发送。任务会在电脑上执行。"
                    : "可以继续编辑本机草稿，连接后再读取消息。"
                }
              />
            ) : undefined
          }
          ListFooterComponent={
            <View style={{ gap: 8 }}>
              <StreamPreview />
              {state.hasNewer && (
                <Action
                  title="较新的消息"
                  quiet
                  disabled={!online || state.loading}
                  onPress={() => {
                    follow.current = false;
                    void controller.history("newer").catch(() => {});
                  }}
                />
              )}
            </View>
          }
        />
        {(away || state.hasNewer || !online) && (
          <Action
            title={online ? "回到最新内容" : "重新连接"}
            quiet
            disabled={state.loading}
            onPress={() => {
              void (online ? latest() : controller.restore()).catch(() => {});
            }}
          />
        )}
        <ScrollView
          style={{
            flexGrow: 0,
            maxHeight: "45%",
            borderTopWidth: 0.5,
            borderTopColor: colors.separator,
          }}
          contentContainerStyle={{ padding: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          <Composer />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
