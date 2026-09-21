import { useTranslation } from "react-i18next";

type Props = {
  firstRun: boolean;
  onCall: () => void;
  onFirstAction: (id: "followUp" | "waiting") => void;
  onSkipFirstRun: () => void;
};

export function EmptyState({ firstRun, onCall, onFirstAction, onSkipFirstRun }: Props) {
  const { t } = useTranslation();

  if (firstRun) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon" aria-hidden>
          <span className="material-symbols-outlined">auto_awesome</span>
        </div>
        <h1 className="empty-state__headline">{t("firstRun.headline")}</h1>
        <p className="empty-state__sub">{t("firstRun.sub")}</p>
        <div className="first-run__actions">
          <button
            type="button"
            className="btn btn-solid empty-state__call"
            onClick={() => onFirstAction("followUp")}
          >
            {t("firstRun.actionFollowUp")}
          </button>
          <button
            type="button"
            className="btn btn-ghost empty-state__call"
            onClick={() => onFirstAction("waiting")}
          >
            {t("firstRun.actionWaiting")}
          </button>
          <button type="button" className="btn-text" onClick={onSkipFirstRun}>
            {t("firstRun.skip")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden>
        <span className="material-symbols-outlined">check_circle</span>
      </div>
      <h1 className="empty-state__headline">{t("empty.headline")}</h1>
      <p className="empty-state__sub">{t("empty.sub")}</p>
      <button type="button" className="btn btn-solid empty-state__call" onClick={onCall}>
        {t("call.open")}
      </button>
    </div>
  );
}
