import type { ResolvedApproval } from "../types";
import { capabilityLabel } from "../lib/brain";

type Props = {
  item: ResolvedApproval;
};

export function ResolvedApprovalCard({ item }: Props) {
  const label = capabilityLabel(item.approval.capability);
  const approved = item.decision === "approve";
  const detail = item.summary ? ` · ${item.summary}` : "";

  return (
    <div
      className={`approval-resolved ${approved ? "approval-resolved--approved" : "approval-resolved--denied"}`}
    >
      {approved ? `Approved — ${label}${detail}` : `Denied — ${label}`}
    </div>
  );
}
