import { useEffect, useState } from "react";
import {
  FlatList,
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  useColorScheme,
} from "react-native";
import { router, useNavigation } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";

export default function Search() {
  useColorScheme();
  const { controller, state } = useMobile();
  const reader = controller.inspection;
  const inspection = state.inspection;
  const page = inspection.search;
  const [query, setQuery] = useState(page?.query ?? "");
  const navigation = useNavigation();
  const online = state.phase === "connected" && inspection.canSearch;
  useEffect(() => {
    const release = navigation.addListener("removed", () => reader.close());
    return () => queueMicrotask(release);
  }, [navigation, reader]);
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
  }, [state.phase]);
  const search = () => {
    if (online && query.trim() && !inspection.loading)
      void reader.searchMessages(query).catch(() => {});
  };
  return (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ padding: 24, gap: 18, paddingBottom: 48 }}
      data={page?.items ?? []}
      keyExtractor={(item) => String(item.seq)}
      ListHeaderComponent={
        <View style={{ gap: 14 }}>
          <Note>搜索当前任务完整消息正文。结果只在本次查看期间保留。</Note>
          {!online && (
            <Note>连接电脑并确认任务授权后可搜索；旧版电脑端需要升级。</Note>
          )}
          <TextInput
            value={query}
            onChangeText={setQuery}
            maxLength={256}
            autoCorrect={false}
            autoCapitalize="none"
            accessibilityLabel="搜索消息关键词"
            placeholder="输入关键词"
            placeholderTextColor={colors.secondary}
            returnKeyType="search"
            onSubmitEditing={search}
            style={{
              padding: 16,
              color: colors.label,
              backgroundColor: colors.panel,
              borderRadius: 12,
            }}
          />
          <Action
            title="搜索"
            disabled={!online || inspection.loading || !query.trim()}
            onPress={search}
          />
          {inspection.loading && (
            <ActivityIndicator accessibilityLabel="正在搜索消息" />
          )}
          {inspection.error && <Note error>{inspection.error}</Note>}
          {page && (
            <Note>{`“${page.query}” · 第 ${page.previous.length + 1} 页${page.items.length ? "" : " · 没有匹配的消息"}`}</Note>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`打开${item.role === "user" ? "你的" : "Hikaro"}消息：${readable(item.snippet)}`}
          disabled={!online || inspection.loading || state.contentLoading}
          onPress={() => {
            void controller.readMessage(item.seq).catch(() => {});
            router.push("/message");
          }}
          style={{
            padding: 18,
            gap: 8,
            borderRadius: 16,
            backgroundColor: colors.panel,
          }}
        >
          <Text style={{ color: colors.secondary }}>
            {item.role === "user"
              ? "你的要求"
              : item.role === "assistant"
                ? "Hikaro"
                : "工具记录"}
          </Text>
          <Text style={{ color: colors.label, fontSize: 16, lineHeight: 24 }}>
            {readable(item.snippet)}
          </Text>
        </Pressable>
      )}
      ListFooterComponent={
        page ? (
          <View style={{ gap: 10 }}>
            <Action
              title="上一页"
              quiet
              disabled={!online || inspection.loading || !page.previous.length}
              onPress={() => {
                void reader
                  .searchMessages(
                    page.query,
                    page.previous.at(-1),
                    page.previous.slice(0, -1),
                  )
                  .catch(() => {});
              }}
            />
            <Action
              title="更早的结果"
              disabled={
                !online || inspection.loading || page.nextBefore === null
              }
              onPress={() => {
                if (page.nextBefore !== null)
                  void reader
                    .searchMessages(page.query, page.nextBefore, [
                      ...page.previous,
                      page.before,
                    ])
                    .catch(() => {});
              }}
            />
          </View>
        ) : undefined
      }
    />
  );
}
