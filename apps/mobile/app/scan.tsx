import { useRef, useState } from "react";
import { View, Text } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors } from "@/theme";
export default function Scan() {
  const [permission, request] = useCameraPermissions(),
    locked = useRef(false),
    [error, setError] = useState<string | null>(null);
  const { controller } = useMobile();
  if (!permission?.granted)
    return (
      <View
        style={{
          flex: 1,
          padding: 24,
          gap: 20,
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <Note>相机只用于扫描你电脑上的配对码，不保存照片。</Note>
        <Action
          title="允许使用相机"
          disabled={permission?.canAskAgain === false}
          onPress={() => {
            void request();
          }}
        />
        <Action title="返回粘贴配对码" quiet onPress={() => router.back()} />
        {permission?.canAskAgain === false && (
          <Note>
            相机权限已关闭。你可以使用粘贴方式，或到系统设置中开启相机。
          </Note>
        )}
      </View>
    );
  return (
    <View style={{ flex: 1, backgroundColor: colors.ink }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (locked.current) return;
          locked.current = true;
          try {
            controller.review(data);
            router.back();
          } catch {
            setError("这不是有效的 Hikaro 配对码，或配对码已过期。");
          }
        }}
      />
      <View
        style={{ padding: 24, gap: 12, backgroundColor: colors.background }}
      >
        <Text style={{ fontSize: 17, color: colors.label }}>
          将电脑上的二维码放入取景框
        </Text>
        {error && (
          <>
            <Note error>{error}</Note>
            <Action
              title="重新扫描"
              onPress={() => {
                locked.current = false;
                setError(null);
              }}
            />
          </>
        )}
        <Action title="返回" quiet onPress={() => router.back()} />
      </View>
    </View>
  );
}
