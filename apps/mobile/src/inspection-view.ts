import { useEffect } from "react";
import { router, useNavigation } from "expo-router";
import { useMobile } from "./provider";

export function useInspectionView() {
  const { controller, state } = useMobile();
  const navigation = useNavigation(),
    reader = controller.inspection;
  useEffect(() => {
    const release = navigation.addListener("removed", () => reader.close());
    return () => queueMicrotask(release);
  }, [navigation, reader]);
  useEffect(() => {
    if (["unpaired", "revoked", "review"].includes(state.phase))
      router.replace("/");
    else if (state.phase === "connected" && !state.inspection.kind)
      router.dismissTo(state.session ? "/task" : "/tasks");
  }, [state.phase, state.inspection.kind, state.session]);
  return {
    reader,
    state,
    inspection: state.inspection,
    online: state.phase === "connected",
  };
}
