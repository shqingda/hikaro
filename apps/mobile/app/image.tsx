import { useEffect, useState, type ComponentProps } from "react";
import {
  ScrollView,
  View,
  Image,
  Text,
  ActivityIndicator,
  useWindowDimensions,
  useColorScheme,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInspectionView } from "@/inspection-view";
import { Action, Note } from "@/ui";
import { colors } from "@/theme";

function ImageAction(props: ComponentProps<typeof Action>) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 90 }}>
      <Action {...props} />
    </View>
  );
}

export default function ImageViewer() {
  useColorScheme();
  const { reader, inspection, online } = useInspectionView();
  const image = inspection.image,
    { width, height } = useWindowDimensions();
  const [zoom, setZoom] = useState(1),
    [decodeError, setDecodeError] = useState(false);
  useEffect(() => {
    setZoom(1);
    setDecodeError(false);
  }, [image?.seq, image?.index, image?.uri]);
  const load = (index: number) => {
    if (image)
      void reader.readImage(image.seq, index, image.count).catch(() => {});
  };
  return (
    <SafeAreaView
      edges={["bottom"]}
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 24, gap: 18 }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: colors.label, fontSize: 23 }}
        >
          {image
            ? `第 ${image.index + 1} / ${image.count} 张图片`
            : "图片已清除"}
        </Text>
        {!online && (
          <Note>连接中断后已清除图片。连接恢复后请从任务重新打开。</Note>
        )}
        {inspection.loading && (
          <>
            <ActivityIndicator accessibilityLabel="正在读取图片" />
            <Note>
              {image?.total
                ? `正在读取 ${Math.floor((image.loaded / image.total) * 100)}%`
                : "正在读取图片…"}
            </Note>
          </>
        )}
        {inspection.error && <Note error>{inspection.error}</Note>}
        {decodeError && <Note error>图片数据无法解码，请在电脑核对原图。</Note>}
        {image?.uri && !decodeError && (
          <ScrollView
            horizontal
            style={{
              height: Math.max(220, height * 0.55),
              backgroundColor: colors.panel,
            }}
          >
            <ScrollView style={{ width: Math.max(1, width - 48) * zoom }}>
              <Image
                key={`${image.seq}:${image.index}`}
                accessible
                accessibilityLabel={`消息第 ${image.index + 1} 张图片`}
                source={{ uri: image.uri }}
                resizeMode="contain"
                resizeMethod="resize"
                onError={() => {
                  if (reader.state.image?.uri === image.uri)
                    setDecodeError(true);
                }}
                style={{
                  width: Math.max(1, width - 48) * zoom,
                  height: Math.max(220, height * 0.55) * zoom,
                }}
              />
            </ScrollView>
          </ScrollView>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <ImageAction
            title="缩小"
            quiet
            disabled={!image?.uri || zoom === 1}
            onPress={() => setZoom(Math.max(1, zoom / 2))}
          />
          <ImageAction
            title="放大"
            quiet
            disabled={!image?.uri || zoom === 4}
            onPress={() => setZoom(Math.min(4, zoom * 2))}
          />
          <ImageAction
            title="适合屏幕"
            quiet
            disabled={!image?.uri || zoom === 1}
            onPress={() => setZoom(1)}
          />
        </View>
        <Note>放大后可滚动查看。图片仅用于当前阅读，不保存到相册。</Note>
        {image && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
            <ImageAction
              title="上一张"
              quiet
              disabled={!online || inspection.loading || image.index === 0}
              onPress={() => load(image.index - 1)}
            />
            <ImageAction
              title="下一张"
              quiet
              disabled={
                !online || inspection.loading || image.index + 1 >= image.count
              }
              onPress={() => load(image.index + 1)}
            />
            {(inspection.error || decodeError) && (
              <ImageAction
                title="重新读取"
                disabled={!online || inspection.loading}
                onPress={() => load(image.index)}
              />
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
