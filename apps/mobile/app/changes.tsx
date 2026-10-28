import {
  FlatList,
  View,
  Text,
  ActivityIndicator,
  useColorScheme,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInspectionView } from "@/inspection-view";
import { Action, Note } from "@/ui";
import { colors, readable } from "@/theme";
import { CONTENT_STEP } from "@/content";
const states = {
  observed: "执行期间观察到",
  committed: "已记录",
  prepared: "结果待核对",
  reverting: "回退结果待核对",
  reverted: "已回退",
};

export default function Changes() {
  const dark = useColorScheme() === "dark";
  const { reader, inspection, online } = useInspectionView();
  const { changes, diff, loading, error } = inspection;
  const load = (offset: number) => {
    if (diff) void reader.readDiff(diff.entry.id, offset).catch(() => {});
  };
  const list = (offset = 0) => {
    void reader.listChanges(offset).catch(() => {});
  };
  const header = (
    <View style={{ gap: 14, marginBottom: 18 }}>
      <Text
        selectable
        accessibilityRole="header"
        style={{ color: colors.label, fontSize: 23 }}
      >
        {diff ? readable(diff.entry.path) : "文件修改记录"}
      </Text>
      <Note>
        {diff
          ? `${states[diff.entry.state]} · 第 ${diff.offset / CONTENT_STEP + 1} 段`
          : changes?.warnings !== undefined
            ? "汇总本任务及子任务的文件修改。Shell／插件差异仅为执行期间观察结果，可能不完整。此页只读。"
            : "仅包含本任务记录的文件工具修改，电脑版本尚不支持其他来源。"}
      </Note>
      {changes?.warnings?.map((warning) => (
        <Note key={warning}>{readable(warning)}</Note>
      ))}
      {changes?.filter?.planId && (
        <Note>
          {changes.filter.step
            ? `计划第 ${changes.filter.step} 步`
            : "计划未关联步骤"}
        </Note>
      )}
      {diff && (
        <Note>这是修改时保存的前后快照，当前工作区可能已变化。此页只读。</Note>
      )}
      {!online && (
        <Note>连接已变化，阅读内容已清除。请恢复连接后重新打开。</Note>
      )}
      {loading && <ActivityIndicator accessibilityLabel="正在读取差异" />}
      {error && (
        <>
          <Note error>{error}</Note>
          <Action
            title={diff ? "刷新记录列表" : "重试读取"}
            disabled={!online || loading}
            onPress={() => list(changes?.offset ?? 0)}
          />
        </>
      )}
    </View>
  );
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      {diff ? (
        <FlatList
          key={`${diff.entry.id}:${diff.offset}`}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 20, paddingBottom: 36 }}
          data={diff.page ? diff.page.data.split("\n") : []}
          keyExtractor={(_, index) => String(index)}
          ListHeaderComponent={header}
          renderItem={({ item }) => (
            <Text
              selectable
              style={{
                fontFamily: Platform.select({
                  ios: "Menlo",
                  android: "monospace",
                }),
                fontSize: 14,
                lineHeight: 21,
                color: item.startsWith("+")
                  ? dark
                    ? "#91dda8"
                    : "#196a34"
                  : item.startsWith("-")
                    ? dark
                      ? "#ffa3a3"
                      : "#a42121"
                    : colors.label,
              }}
            >
              {readable(item) || " "}
            </Text>
          )}
          ListFooterComponent={
            <View style={{ gap: 14, marginTop: 24 }}>
              <Action
                title="上一段"
                quiet
                disabled={!online || loading || !diff.offset}
                onPress={() => load(Math.max(0, diff.offset - CONTENT_STEP))}
              />
              <Action
                title="下一段"
                quiet
                disabled={!online || loading || diff.page?.nextOffset == null}
                onPress={() => {
                  if (diff.page?.nextOffset != null) load(diff.page.nextOffset);
                }}
              />
              <Action
                title="返回修改列表"
                quiet
                onPress={() => reader.closeDiff()}
              />
            </View>
          }
        />
      ) : (
        <FlatList
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 36 }}
          data={changes?.items ?? []}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          ListEmptyComponent={
            !loading && !error ? <Note>没有已记录的文件修改。</Note> : undefined
          }
          renderItem={({ item }) => (
            <View style={{ gap: 6 }}>
              <Note>
                {item.after === null
                  ? "删除"
                  : item.before === null
                    ? "新建"
                    : "编辑"}{" "}
                · {states[item.state]} ·{" "}
                {new Date(item.timestamp).toLocaleString()}
                {item.runId ? ` · 运行 ${item.runId.slice(0, 8)}` : ""}
                {item.source
                  ? ` · ${item.source === "file" ? "文件工具" : item.source}`
                  : ""}
                {item.depth ? ` · 子任务 ${item.sessionId?.slice(0, 8)}` : ""}
              </Note>
              <Action
                title={readable(item.path)}
                quiet
                disabled={!online || loading}
                onPress={() => {
                  void reader.readDiff(item.id).catch(() => {});
                }}
              />
            </View>
          )}
          ListFooterComponent={
            <View style={{ gap: 14 }}>
              <Action
                title="较新的记录"
                quiet
                disabled={!online || loading || !changes?.previous.length}
                onPress={() => list(changes?.previous.at(-1) ?? 0)}
              />
              <Action
                title="较早的记录"
                quiet
                disabled={!online || loading || !changes?.more}
                onPress={() => {
                  if (changes) list(changes.offset + changes.items.length);
                }}
              />
              <Action
                title="刷新记录"
                quiet
                disabled={!online || loading}
                onPress={() => list()}
              />
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}
