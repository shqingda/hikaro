import { memo, useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  View,
  Linking,
  useColorScheme,
  Pressable,
} from "react-native";
import {
  Host,
  Button,
  Row,
  BottomSheet,
  Column,
  Text as NativeText,
} from "@expo/ui";
import { Image } from "expo-image";
import Markdown from "react-native-markdown-display";
import { useFocusEffect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { useSession } from "../src/session-context";
import { colors } from "../src/theme";
import type { MessageRow } from "../../../packages/client-state/src/index.ts";
const MessageView = memo(function MessageView({ row }: { row: MessageRow }) {
  const [expanded, setExpanded] = useState(false);
  const m = row.message;
  return (
    <View style={{ gap: 8 }}>
      <Text
        style={{
          fontSize: 12,
          color: m.role === "user" ? colors.accent : colors.secondary,
        }}
      >
        {m.role === "user" ? "You" : m.role === "tool" ? m.name : "Hikaro"}
        {m.isError ? " · failed" : ""}
      </Text>
      {m.role === "tool" ? (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded(!expanded)}
          >
            <Text style={{ color: colors.secondary }}>
              {expanded ? "Hide output" : "Show output"}
            </Text>
          </Pressable>
          {expanded ? (
            <Text
              selectable
              style={{ color: colors.label, fontFamily: "monospace" }}
            >
              {m.text}
            </Text>
          ) : null}
        </>
      ) : m.role === "assistant" ? (
        <Markdown
          style={{
            body: { color: colors.label, fontSize: 16, lineHeight: 25 },
            code_inline: { backgroundColor: colors.surface },
            fence: { backgroundColor: colors.surface, color: colors.label },
            code_block: {
              backgroundColor: colors.surface,
              color: colors.label,
            },
            link: { color: colors.accent },
          }}
          onLinkPress={(url) => {
            if (/^https?:\/\//.test(url)) void Linking.openURL(url);
            return false;
          }}
        >
          {m.text}
        </Markdown>
      ) : (
        <Text
          selectable
          style={{ fontSize: 16, lineHeight: 25, color: colors.label }}
        >
          {m.text}
        </Text>
      )}
    </View>
  );
});
export default function Home() {
  useColorScheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, controller, client, error, refresh } = useSession();
  const [draft, setDraft] = useState("");
  const [showSessions, setShowSessions] = useState(false);
  const list = useRef<FlatList<MessageRow>>(null);
  const follow = useRef(true);
  const approval = state.approvals[0];
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  const send = async () => {
    const text = draft;
    if (await controller?.send(text))
      setDraft((value) => (value === text ? "" : value));
  };
  const notify = async () => {
    try {
      const permission = await Notifications.requestPermissionsAsync();
      if (permission.status !== "granted") return;
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId)
        throw Error("Set your EAS project ID before enabling notifications.");
      const token = await Notifications.getExpoPushTokenAsync({ projectId });
      await client?.request("push.register", { token: token.data });
    } catch (e) {
      controller?.setError(e);
    }
  };
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={{ paddingHorizontal: 24, paddingVertical: 8 }}>
        <Text selectable style={{ color: colors.secondary }}>
          {state.recovering
            ? "Restoring session…"
            : state.status === "connected"
              ? "Connected · encrypted"
              : state.status}
        </Text>
      </View>
      <FlatList
        ref={list}
        contentInsetAdjustmentBehavior="automatic"
        data={state.rows}
        keyExtractor={(row) => String(row.seq)}
        contentContainerStyle={{ padding: 24, gap: 24, flexGrow: 1 }}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={7}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={(e) => {
          const n = e.nativeEvent;
          follow.current =
            n.contentSize.height -
              n.contentOffset.y -
              n.layoutMeasurement.height <
            80;
        }}
        onContentSizeChange={() => {
          if (follow.current && !state.hasNewer)
            list.current?.scrollToEnd({ animated: false });
        }}
        renderItem={({ item }) => <MessageView row={item} />}
        ListHeaderComponent={
          state.hasOlder ? (
            <Host matchContents>
              <Button
                onPress={() => {
                  follow.current = false;
                  void controller?.history();
                }}
              >
                {state.historyPending ? "Loading…" : "Earlier messages"}
              </Button>
            </Host>
          ) : null
        }
        ListEmptyComponent={
          <View style={{ gap: 16, paddingTop: 60 }}>
            <Image
              source={require("../../../brand/hikaro-icon-transparent.png")}
              style={{ width: 64, height: 64 }}
              contentFit="contain"
            />
            <Text
              selectable
              style={{ fontSize: 28, fontWeight: "600", color: colors.label }}
            >
              {state.status === "unpaired"
                ? "Connect a computer"
                : "New session"}
            </Text>
            <Text
              selectable
              style={{ fontSize: 16, lineHeight: 24, color: colors.secondary }}
            >
              {state.status === "unpaired"
                ? "Pair your computer to continue its sessions and review permissions."
                : "Ask about the project, or describe a change."}
            </Text>
            {state.status === "unpaired" ? (
              <Host matchContents>
                <Button onPress={() => router.push("/pair")}>
                  Pair computer
                </Button>
              </Host>
            ) : null}
          </View>
        }
        ListFooterComponent={
          <>
            {state.stream ? (
              <Text
                selectable
                style={{ fontSize: 16, lineHeight: 25, color: colors.label }}
              >
                {state.stream.slice(-16000)}
              </Text>
            ) : null}
            {state.streamTruncated || state.stream.length > 16000 ? (
              <Text style={{ color: colors.secondary }}>
                Showing recent output. The complete response is available when
                finished.
              </Text>
            ) : null}
            {state.hasNewer ? (
              <Host matchContents>
                <Button
                  onPress={() => {
                    follow.current = true;
                    void controller?.history(false);
                  }}
                >
                  Latest messages
                </Button>
              </Host>
            ) : null}
          </>
        }
      />
      <View
        style={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(insets.bottom, 12),
          gap: 10,
        }}
      >
        {state.error || error ? (
          <Text
            selectable
            accessibilityRole="alert"
            style={{ color: colors.accent }}
          >
            {state.error || error}
          </Text>
        ) : null}
        <TextInput
          accessibilityLabel="Message Hikaro"
          placeholder={state.busy ? "Add guidance…" : "Message Hikaro"}
          placeholderTextColor="#888"
          multiline
          value={draft}
          onChangeText={setDraft}
          editable={state.status === "connected" && !state.recovering}
          style={{
            minHeight: 48,
            maxHeight: 160,
            padding: 14,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 16,
            color: colors.label,
          }}
        />
        <Host matchContents>
          <Row>
            <Button onPress={() => void send()}>
              {state.busy ? "Steer" : "Send"}
            </Button>
            {state.busy ? (
              <Button onPress={() => void controller?.cancel()}>Stop</Button>
            ) : null}
            <Button onPress={() => setShowSessions(true)}>Sessions</Button>
            <Button onPress={() => router.push("/pair")}>Pair</Button>
            <Button onPress={() => void notify()}>Notify</Button>
          </Row>
        </Host>
      </View>
      <Host>
        <BottomSheet
          isPresented={!!approval}
          onDismiss={() => {
            if (approval) void controller?.respond(approval.id, false);
          }}
          snapPoints={["half", "full"]}
        >
          <Column>
            <NativeText>Permission requested</NativeText>
            <NativeText>{approval?.reason ?? ""}</NativeText>
            <Button
              onPress={() => {
                if (approval) void controller?.respond(approval.id, true);
              }}
            >
              Allow once
            </Button>
            <Button
              onPress={() => {
                if (approval) void controller?.respond(approval.id, false);
              }}
            >
              Deny
            </Button>
          </Column>
        </BottomSheet>
        <BottomSheet
          isPresented={showSessions}
          onDismiss={() => setShowSessions(false)}
          snapPoints={["half", "full"]}
        >
          <Column>
            <NativeText>Sessions</NativeText>
            <Button
              onPress={() => {
                void controller?.select().then((ok) => {
                  if (ok) setShowSessions(false);
                });
              }}
            >
              New session
            </Button>
            {state.sessions.slice(0, 30).map((s) => (
              <Button
                key={s.id}
                onPress={() => {
                  void controller?.select(s.id).then((ok) => {
                    if (ok) setShowSessions(false);
                  });
                }}
              >
                {s.title}
              </Button>
            ))}
          </Column>
        </BottomSheet>
      </Host>
    </KeyboardAvoidingView>
  );
}
