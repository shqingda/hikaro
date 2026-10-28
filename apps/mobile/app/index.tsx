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
import { PairingProgress, usePairingFlow } from "@/pairing-flow";
export default function Connect() {
  useColorScheme();
  const { controller, state } = useMobileSelector((s) => ({
    phase: s.phase,
    landing: s.landing,
    review: s.review,
    deviceId: s.deviceId,
    error: s.error,
    messages: s.messages,
    session: s.session,
    composer: s.composer,
  }));
  const pairing = usePairingFlow(controller);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (state.phase === "connected" && state.landing)
      router.replace(state.landing === "task" ? "/task" : "/tasks");
  }, [state.phase, state.landing]);
  const pending =
    ["connecting", "restoring"].includes(state.phase) ||
    (state.phase === "connected" && state.landing === null);
  const review = async () => {
    Keyboard.dismiss();
    if (await pairing.start(draft.trim())) setDraft("");
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
        !pairing.pending &&
        !state.review &&
        !["offline", "error", "blocked"].includes(state.phase) && (
          <Section title="开始接续">
            <Text style={{ color: colors.label, fontSize: 16, lineHeight: 26 }}>
              1 在电脑 TUI 输入 /pair
            </Text>
            <Text style={{ color: colors.label, fontSize: 16, lineHeight: 26 }}>
              2 扫码或输入六位码，在电脑确认连接
            </Text>
          </Section>
        )}
      {pairing.pending && (
        <PairingProgress waiting={pairing.waiting} cancel={pairing.cancel} />
      )}
      {pending && (
        <View style={{ gap: 12 }}>
          <ActivityIndicator accessibilityLabel="正在连接电脑" />
          <Note>
            正在准备任务。首次配对请在电脑上确认，这台手机即可接续任务。
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
            保存这台电脑
          </Text>
          <Note>{new URL(state.review.relay).hostname}</Note>
          <Note>保存连接后即可查看已有任务、发送消息、审批和停止。</Note>
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
      {(pairing.error || state.error) && (
        <Note error>{pairing.error ?? state.error}</Note>
      )}
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
      {!pending && !pairing.pending && !state.review && (
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
                title={manual ? "收起手动输入" : "输入六位配对码"}
                quiet
                onPress={() => setManual(!manual)}
              />
              {manual && (
                <View style={{ gap: 12 }}>
                  <Note>输入电脑 /pair 显示的六位数字，五分钟内有效。</Note>
                  <TextInput
                    testID="pairing-code"
                    accessibilityLabel="配对码"
                    value={draft}
                    onChangeText={setDraft}
                    keyboardType="number-pad"
                    maxLength={8192}
                    secureTextEntry={draft.startsWith("hikaro://pair#")}
                    autoCorrect={false}
                    autoCapitalize="none"
                    placeholder="000000"
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
                    title="连接电脑"
                    testID="review-pairing"
                    disabled={
                      !/^\d{6}$/.test(draft.trim()) &&
                      !draft.trim().startsWith("hikaro://pair#") &&
                      !draft.trim().startsWith("hikaro://connect#")
                    }
                    quiet
                    onPress={() => {
                      void review();
                    }}
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
