import type { ApprovalRecord } from "../types";
import { capabilityLabel } from "../lib/brain";

type Props = {
  approval: ApprovalRecord;
  busy: boolean;
  onResolve: (decision: "approve" | "deny") => void;
};

function metaIcon(capability: string): string {
  if (capability.startsWith("code.")) return "code";
  if (capability.startsWith("deploy.")) return "dns";
  if (capability.startsWith("mail.")) return "mail";
  if (capability.startsWith("notify.")) return "notifications";
  return "link";
}

export function ApprovalCard({ approval, busy, onResolve }: Props) {
  const meta = [approval.playbookId, approval.signalId].filter(Boolean).join(" · ");

  return (
    <article className="approval-card">
      <h2 className="approval-card__cap">{capabilityLabel(approval.capability)}</h2>
      <p className="approval-card__meta">
        <span className="material-symbols-outlined">{metaIcon(approval.capability)}</span>
        <span>{meta || approval.id}</span>
      </p>
      <div className="approval-card__actions">
        <button
          type="button"
          className="btn btn-deny"
          disabled={busy}
          onClick={() => onResolve("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="btn btn-approve"
          disabled={busy}
          onClick={() => onResolve("approve")}
        >
          Approve
        </button>
      </div>
    </article>
  );
}
