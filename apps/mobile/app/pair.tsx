import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Host, Button, Column } from "@expo/ui";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useSession } from "../src/session-context";
import { pair } from "../src/connection";
export default function Pair() {
  const [uri, setUri] = useState("");
  const [error, setError] = useState("");
  const [scan, setScan] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const router = useRouter();
  const { refresh } = useSession();
  const connect = async (value: string) => {
    setScan(false);
    try {
      await pair(value);
      await refresh();
      router.back();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 24, gap: 20 }}
    >
      <Text selectable style={{ fontSize: 24, fontWeight: "600" }}>
        Pair a computer
      </Text>
      <Text selectable>
        On your computer, create a pairing code with Hikaro. The code expires
        after five minutes.
      </Text>
      {scan && permission?.granted ? (
        <CameraView
          style={{ height: 300, borderRadius: 16 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(result) => void connect(result.data)}
        />
      ) : null}
      <Host matchContents>
        <Column>
          <Button
            onPress={async () => {
              if (!permission?.granted) await requestPermission();
              setScan(true);
            }}
          >
            Scan pairing code
          </Button>
        </Column>
      </Host>
      <TextInput
        accessibilityLabel="Pairing code"
        value={uri}
        onChangeText={setUri}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Paste hikaro://pair…"
        style={{
          minHeight: 100,
          padding: 16,
          borderWidth: 1,
          borderColor: "#aaa",
          borderRadius: 12,
        }}
      />
      <Host matchContents>
        <Button onPress={() => void connect(uri)}>Pair computer</Button>
      </Host>
      {error ? (
        <Text selectable accessibilityRole="alert" style={{ color: "#c45548" }}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}
