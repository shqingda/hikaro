import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { fetch } from "expo/fetch";
import {
  resolvePairing,
  type PairingWaiting,
} from "../../../packages/remote/src/pairing-client";
import type { MobileController } from "./controller";
import { Action, Note } from "./ui";
import { colors } from "./theme";

export function usePairingFlow(controller: MobileController) {
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState<PairingWaiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setPending(false);
    setWaiting(null);
  }, []);
  useFocusEffect(useCallback(() => cancel, [cancel]));
  const start = async (value: string) => {
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    setPending(true);
    setWaiting(null);
    setError(null);
    try {
      const uri = await resolvePairing(value, {
        fetch,
        signal: request.signal,
        onWaiting: (state) => {
          if (active.current === request) setWaiting(state);
        },
      });
      if (active.current !== request || request.signal.aborted) return false;
      controller.review(uri);
      return true;
    } catch (e) {
      if (active.current === request && !request.signal.aborted)
        setError(
          e instanceof Error ? e.message : "配对失败，请重新输入 /pair 后重试",
        );
      return false;
    } finally {
      if (active.current === request) {
        active.current = null;
        setPending(false);
        setWaiting(null);
      }
    }
  };
  return { pending, waiting, error, start, cancel };
}
export function PairingProgress({
  waiting,
  cancel,
}: {
  waiting: PairingWaiting | null;
  cancel: () => void;
}) {
  return (
    <View style={{ gap: 16 }}>
      <ActivityIndicator
        accessibilityLabel={waiting ? "等待电脑确认" : "正在查找电脑"}
      />
      {waiting ? (
        <>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 20, fontWeight: "600", color: colors.label }}
          >
            在电脑上确认连接
          </Text>
          <Note>核对电脑和手机显示的校验码一致，再在电脑上选择允许。</Note>
          <Text
            selectable
            accessibilityLabel={`校验码 ${waiting.fingerprint}`}
            style={{
              fontSize: 32,
              fontWeight: "600",
              letterSpacing: 3,
              color: colors.label,
            }}
          >
            {waiting.fingerprint}
          </Text>
          <Note>配对码仅本次有效。请保持此页面打开。</Note>
        </>
      ) : (
        <Note>正在查找电脑…</Note>
      )}
      <Action title="取消配对" quiet onPress={cancel} />
    </View>
  );
}
