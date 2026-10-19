import { useEffect } from "react";
import {
  ScrollView,
  View,
  Text,
  ActivityIndicator,
  useColorScheme,
} from "react-native";
import { router, useNavigation } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
import { CONTENT_STEP } from "@/content";

export default function Message() {
  useColorScheme();
  const { controller, state } = useMobile();
  const navigation = useNavigation();
  const content = state.content;
  const online = state.phase === "connected";
  useEffect(() => {
    const release = navigation.addListener("removed", () =>
      controller.closeMessage(),
    );
    // Router emits removed after unmount, so retain the listener through cleanup.
    return () => queueMicrotask(release);
  }, [navigation, controller]);
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (online && !content) router.dismissTo("/task");
  }, [state.phase, online, content]);
  const load = (offset: number) => {
    if (content)
      void controller.readMessage(content.seq, offset).catch(() => {});
  };
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ScrollView
        key={
          content
            ? `${content.sessionId}:${content.seq}:${content.offset}`
            : "empty"
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 24, gap: 20, paddingBottom: 48 }}
        style={{ flex: 1 }}
      >
        <Text
          accessibilityRole="header"
          selectable
          style={{ color: colors.label, fontSize: 23, lineHeight: 31 }}
        >
          {readable(state.session?.title ?? "消息正文")}
        </Text>
        <Note>
          {!online
            ? "离线快照 · 正文可能已变化"
            : content
              ? `第 ${content.offset / CONTENT_STEP + 1} 段 · 按需读取，不保存正文到手机`
              : "详情已清除，请返回任务重新打开消息。"}
        </Note>
        {state.contentLoading && (
          <ActivityIndicator accessibilityLabel="正在读取正文" />
        )}
        {state.contentError && <Note error>{state.contentError}</Note>}
        {content && state.contentError && (
          <Action
            title="重试这一段"
            disabled={!online || state.contentLoading}
            onPress={() => load(content.offset)}
          />
        )}
        {content?.page && (
          <Text
            selectable
            style={{ color: colors.label, fontSize: 16, lineHeight: 25 }}
          >
            {readable(content.page.data) || "这条消息没有正文。"}
          </Text>
        )}
      </ScrollView>
      {content ? (
        <View
          style={{
            gap: 8,
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderTopWidth: 1,
            borderTopColor: colors.separator,
          }}
        >
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Action
                title="上一段"
                quiet
                disabled={
                  !online || state.contentLoading || content.offset === 0
                }
                onPress={() => load(Math.max(0, content.offset - CONTENT_STEP))}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Action
                title="下一段"
                disabled={
                  !online ||
                  state.contentLoading ||
                  content.page?.nextOffset == null
                }
                onPress={() => {
                  if (content.page?.nextOffset != null)
                    load(content.page.nextOffset);
                }}
              />
            </View>
          </View>
          <Action
            title="回到开头"
            quiet
            disabled={!online || state.contentLoading || content.offset === 0}
            onPress={() => load(0)}
          />
        </View>
      ) : (
        <Action
          title="返回任务"
          quiet
          onPress={() => router.dismissTo("/task")}
        />
      )}
    </SafeAreaView>
  );
}
