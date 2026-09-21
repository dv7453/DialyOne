import { useTranslation } from "react-i18next";
import type { ApprovalRecord } from "../types";
import { approvalFacts } from "../lib/approval-facts";
import { capabilityLabel } from "../lib/brain";
import { isIrreversible } from "../lib/severity";

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
  if (
    capability.startsWith("filing.") ||
    capability.startsWith("gst.") ||
    capability.startsWith("tax.")
  ) {
    return "gavel";
  }
  if (
    capability.startsWith("payment.") ||
    capability.startsWith("pay.") ||
    capability.startsWith("money.") ||
    capability.startsWith("bank.")
  ) {
    return "payments";
  }
  return "link";
}

export function ApprovalCard({ approval, busy, onResolve }: Props) {
  const { t } = useTranslation();
  const meta = [approval.playbookId, approval.signalId].filter(Boolean).join(" · ");
  const facts = approvalFacts(approval.args);
  const irreversible = isIrreversible(approval.capability, approval.severity);
  const bodyKeys = new Set(["body", "description", "notice"]);

  return (
    <article className={`approval-card${irreversible ? " approval-card--irreversible" : ""}`}>
      {irreversible ? (
        <p className="approval-card__warn">
          <span className="material-symbols-outlined">warning</span>
          {t("approvals.irreversibleWarn")}
        </p>
      ) : null}
      <h2 className="approval-card__cap">{capabilityLabel(approval.capability)}</h2>
      <p className="approval-card__meta">
        <span className="material-symbols-outlined">{metaIcon(approval.capability)}</span>
        <span>{meta || approval.id}</span>
      </p>
      {facts.length > 0 ? (
        <dl className="approval-card__facts">
          {facts.map((fact) => (
            <div key={fact.key} className="approval-card__fact">
              <dt>{t(`approvals.facts.${fact.key}`)}</dt>
              <dd className={bodyKeys.has(fact.key) ? "approval-card__fact-body" : undefined}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="approval-card__actions">
        <button
          type="button"
          className="btn btn-deny"
          disabled={busy}
          onClick={() => onResolve("deny")}
        >
          {t("approvals.deny")}
        </button>
        <button
          type="button"
          className={`btn btn-approve${irreversible ? " btn-approve--heavy" : ""}`}
          disabled={busy}
          onClick={() => onResolve("approve")}
        >
          {t("approvals.approve")}
        </button>
      </div>
    </article>
  );
}
