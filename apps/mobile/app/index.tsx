import { useEffect, useState } from "react";
import {
  View,
  Text,
  Keyboard,
  TextInput,
  useColorScheme,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { useMobileSelector } from "@/provider";
import {
  Action,
  Note,
  SunMark,
  Page,
  Section,
  confirmConnectionRemoval,
} from "@/ui";
import { colors } from "@/theme";
export default function Connect() {
  useColorScheme();
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    review: s.review,
    deviceId: s.deviceId,
    error: s.error,
    messages: s.messages,
    session: s.session,
    composer: s.composer,
  }));
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState(""),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (state.phase === "connected") router.replace("/tasks");
  }, [state.phase]);
  const pending = ["connecting", "restoring"].includes(state.phase);
  const review = () => {
    try {
      controller.review(draft.trim());
      setDraft("");
      setError(null);
      Keyboard.dismiss();
    } catch {
      setError("配对码无效或已过期。请从电脑重新生成，再扫描或粘贴。");
    }
  };
  return (
    <Page
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="interactive"
      contentContainerStyle={{ padding: 20, gap: 24, paddingBottom: 40 }}
      style={{ backgroundColor: colors.background }}
    >
      <View style={{ gap: 16, paddingTop: 16 }}>
        <SunMark />
        <Text
          accessibilityRole="header"
          style={{
            fontSize: 30,
            lineHeight: 38,
            fontWeight: "600",
            color: colors.label,
          }}
        >
          连接你的电脑
        </Text>
        <Note>任务留在电脑。随时查看进展、审批操作，继续对话。</Note>
      </View>
      {!pending &&
        !state.review &&
        !["offline", "error", "blocked"].includes(state.phase) && (
          <Section title="开始接续">
            <Text style={{ color: colors.label, fontSize: 16, lineHeight: 26 }}>
              1 在电脑端生成手机配对码
            </Text>
            <Text style={{ color: colors.label, fontSize: 16, lineHeight: 26 }}>
              2 扫码核对，再由电脑确认授权
            </Text>
          </Section>
        )}
      {pending && (
        <View style={{ gap: 12 }}>
          <ActivityIndicator accessibilityLabel="正在连接电脑" />
          <Note>
            正在连接。首次配对请在电脑上确认这台手机，然后授予任务查看权。
          </Note>
          {state.deviceId && (
            <Text selectable style={{ fontSize: 12, color: colors.secondary }}>
              设备 {state.deviceId}
            </Text>
          )}
          <Action
            title="移除连接"
            quiet
            onPress={() => confirmConnectionRemoval(controller)}
          />
        </View>
      )}
      {state.review && (
        <View
          style={{
            gap: 14,
            padding: 20,
            borderRadius: 20,
            borderCurve: "continuous",
            backgroundColor: colors.panel,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ fontSize: 20, fontWeight: "600", color: colors.label }}
          >
            核对你的电脑
          </Text>
          <Note>{state.review.relay}</Note>
          <Text selectable style={{ color: colors.label, fontSize: 13 }}>
            主机 {state.review.hostId}
          </Text>
          <Text selectable style={{ color: colors.secondary, fontSize: 12 }}>
            公钥 {state.review.hostKey}
          </Text>
          <Note>确认与你电脑上的配对信息一致，再保存连接。</Note>
          <Action
            title="保存并连接"
            testID="confirm-pairing"
            onPress={() => {
              void controller.confirm().catch(() => {});
            }}
          />
          <Action
            title="取消"
            quiet
            onPress={() => {
              void controller.forget().catch(() => {});
            }}
          />
        </View>
      )}
      {(error || state.error) && <Note error>{error ?? state.error}</Note>}
      {state.phase !== "connected" &&
        state.session &&
        state.composer.record && (
          <Action
            title={
              state.messages.length ? "查看上次任务与草稿" : "继续编辑本机草稿"
            }
            onPress={() => router.push("/task")}
          />
        )}
      {!pending && !state.review && (
        <View style={{ gap: 16 }}>
          {["offline", "error", "blocked"].includes(state.phase) && (
            <>
              <Note>
                重新连接不会自动发送草稿。移除连接会清除本机配对、未发送草稿和历史缓存。
              </Note>
              <Action
                title="重新连接"
                onPress={() => {
                  void controller.restore();
                }}
              />
              <Action
                title="移除连接"
                quiet
                onPress={() => confirmConnectionRemoval(controller)}
              />
            </>
          )}
          {!["offline", "error", "blocked"].includes(state.phase) && (
            <>
              <Action
                title="扫描电脑上的配对码"
                testID="scan-pairing"
                onPress={() => router.push("/scan")}
              />
              <Action
                title={manual ? "收起手动输入" : "手动输入配对码"}
                quiet
                onPress={() => setManual(!manual)}
              />
              {manual && (
                <View style={{ gap: 12 }}>
                  <Note>配对码包含设备凭据，请不要发给他人。</Note>
                  <TextInput
                    testID="pairing-code"
                    accessibilityLabel="配对码"
                    value={draft}
                    onChangeText={setDraft}
                    secureTextEntry
                    maxLength={8192}
                    autoCorrect={false}
                    autoCapitalize="none"
                    placeholder="hikaro://pair#…"
                    placeholderTextColor={colors.secondary}
                    style={{
                      padding: 16,
                      minHeight: 48,
                      borderRadius: 12,
                      backgroundColor: colors.panel,
                      color: colors.label,
                    }}
                  />
                  <Action
                    title="核对配对信息"
                    testID="review-pairing"
                    disabled={!draft.trim()}
                    quiet
                    onPress={review}
                  />
                </View>
              )}
            </>
          )}
        </View>
      )}
    </Page>
  );
}
