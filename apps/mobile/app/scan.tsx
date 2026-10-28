import { useRef, useState } from "react";
import { ScrollView, View, Text, useColorScheme } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useMobile } from "@/provider";
import { Action, Note } from "@/ui";
import { colors } from "@/theme";
export default function Scan() {
  useColorScheme();
  const [permission, request] = useCameraPermissions(),
    locked = useRef(false),
    [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const { controller } = useMobile();
  async function requestPermission() {
    if (requesting) return;
    setRequesting(true);
    setError(null);
    try {
      await request();
    } catch {
      setError("无法请求相机权限。请重试，或返回粘贴配对码。");
    } finally {
      setRequesting(false);
    }
  }
  if (!permission?.granted || cameraFailed)
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{
          flexGrow: 1,
          padding: 20,
          paddingBottom: 40,
          gap: 20,
          justifyContent: "center",
        }}
      >
        <Note>相机只用于扫描你电脑上的配对码，不保存照片。</Note>
        {error && <Note error>{error}</Note>}
        {cameraFailed ? (
          <Action
            title="重新打开相机"
            onPress={() => {
              locked.current = false;
              setError(null);
              setCameraFailed(false);
            }}
          />
        ) : (
          <Action
            title={requesting ? "正在请求相机权限…" : "允许使用相机"}
            disabled={requesting || permission?.canAskAgain === false}
            onPress={() => {
              void requestPermission();
            }}
          />
        )}
        <Action title="返回粘贴配对码" quiet onPress={() => router.back()} />
        {permission?.canAskAgain === false && (
          <Note>
            相机权限已关闭。你可以使用粘贴方式，或到系统设置中开启相机。
          </Note>
        )}
      </ScrollView>
    );
  return (
    <View style={{ flex: 1, backgroundColor: colors.ink }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        onMountError={() => {
          locked.current = true;
          setError("相机未能启动。可以重试，或返回粘贴电脑上的配对码。");
          setCameraFailed(true);
        }}
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
        style={{ padding: 20, gap: 12, backgroundColor: colors.background }}
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
