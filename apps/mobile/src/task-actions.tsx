import { useState } from "react";
import { View, Text } from "react-native";
import { useMobile } from "./provider";
import { Action, Note } from "./ui";
import { colors, readable } from "./theme";

const receipts = {
  pending: "等待回执",
  acknowledged: "电脑已收到",
  completed: "已处理",
  failed: "未成功",
  unknown: "结果未知，未重发",
};
export function TaskActions() {
  const { controller, state } = useMobile();
  const [expanded, setExpanded] = useState<string | null>(null);
  const canControl =
    state.phase === "connected" &&
    ["owner", "control"].includes(state.sessionRole ?? "");
  return (
    <View style={{ gap: 12 }}>
      {!canControl && (
        <Note>
          当前仅可查看。审批需要电脑授予这项任务的控制权限，并保持连接。
        </Note>
      )}
      {state.approvals.map((approval) => (
        <View
          key={approval.id}
          style={{
            gap: 10,
            borderWidth: 1,
            borderColor: colors.secondary,
            padding: 16,
            borderRadius: 16,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ color: colors.label, fontSize: 18 }}
          >
            待审批 · {readable(approval.tool)}
          </Text>
          <Action
            title={expanded === approval.id ? "收起详情" : "查看完整审批详情"}
            quiet
            onPress={() =>
              setExpanded(expanded === approval.id ? null : approval.id)
            }
          />
          {expanded === approval.id && (
            <>
              <Text
                selectable
                style={{ color: colors.label, fontSize: 16, lineHeight: 24 }}
              >
                {readable(approval.reason)}
              </Text>
              <Text
                selectable
                style={{ color: colors.label, fontSize: 15, lineHeight: 23 }}
              >
                {readable(JSON.stringify(approval.arguments, null, 2))}
              </Text>
              {approval.capability && (
                <Note>
                  {approval.capability.write ? "写入" : "读取"}：
                  {approval.capability.path}
                </Note>
              )}
              <Note>
                仅处理本次请求，不更改任务权限。请求失效或已被其他设备处理时，电脑会拒绝。
              </Note>
              <Action
                title="允许这一次"
                disabled={!canControl || !!state.actionPending}
                onPress={() => {
                  void controller
                    .respondApproval(approval.id, true)
                    .catch(() => {});
                }}
              />
              <Action
                title="拒绝"
                quiet
                disabled={!canControl || !!state.actionPending}
                onPress={() => {
                  void controller
                    .respondApproval(approval.id, false)
                    .catch(() => {});
                }}
              />
            </>
          )}
        </View>
      ))}
      {state.actionNotice && <Note>{state.actionNotice}</Note>}
      {state.receipts.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text
            accessibilityRole="header"
            style={{ color: colors.label, fontSize: 16 }}
          >
            本设备审批回执
          </Text>
          {state.receipts.slice(-8).map((receipt) => (
            <Note key={receipt.id}>
              {receipts[receipt.status]} · {receipt.id}
            </Note>
          ))}
          <Action
            title="核对未确认的操作"
            quiet
            disabled={state.phase !== "connected" || !!state.actionPending}
            onPress={() => {
              void controller.reconcileActions().catch(() => {});
            }}
          />
        </View>
      )}
    </View>
  );
}
