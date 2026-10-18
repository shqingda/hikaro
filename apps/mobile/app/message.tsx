import { useEffect, useRef } from "react";
import {
  ScrollView,
  View,
  Text,
  ActivityIndicator,
  useColorScheme,
  type ScrollViewInstance,
} from "react-native";
import { router, useNavigation } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
import { CONTENT_STEP } from "@/content";

export default function Message() {
  useColorScheme();
  const { controller, state } = useMobile();
  const navigation = useNavigation();
  const scroll = useRef<ScrollViewInstance>(null);
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
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [content?.offset, content?.seq]);
  const load = (offset: number) => {
    if (content)
      void controller.readMessage(content.seq, offset).catch(() => {});
  };
  return (
    <ScrollView
      ref={scroll}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 24, gap: 20, paddingBottom: 48 }}
      style={{ backgroundColor: colors.background }}
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
      {content?.page && (
        <Text
          selectable
          style={{ color: colors.label, fontSize: 16, lineHeight: 25 }}
        >
          {readable(content.page.data) || "这条消息没有正文。"}
        </Text>
      )}
      {content && (
        <View style={{ gap: 12 }}>
          {state.contentError && (
            <Action
              title="重试这一段"
              disabled={!online || state.contentLoading}
              onPress={() => load(content.offset)}
            />
          )}
          <Action
            title="上一段"
            quiet
            disabled={!online || state.contentLoading || content.offset === 0}
            onPress={() => load(Math.max(0, content.offset - CONTENT_STEP))}
          />
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
          {content.offset > 0 && (
            <Action
              title="回到开头"
              quiet
              disabled={!online || state.contentLoading}
              onPress={() => load(0)}
            />
          )}
        </View>
      )}
      <Action title="返回任务" quiet onPress={() => router.back()} />
    </ScrollView>
  );
}
