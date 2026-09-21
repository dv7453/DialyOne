import { useTranslation } from "react-i18next";
import { CONNECTORS, type NeededConnection } from "../lib/connections";

type Props = {
  needed: NeededConnection;
  onDismiss: () => void;
};

export function ConnectionCard({ needed, onDismiss }: Props) {
  const { t } = useTranslation();
  const meta = CONNECTORS.find((item) => item.key === needed.connector);
  const key = needed.connector;

  return (
    <article className="connection-card">
      <span className="material-symbols-outlined connection-card__icon" aria-hidden>
        {meta?.icon ?? "link"}
      </span>
      <div className="connection-card__body">
        <h2 className="connection-card__title">{t(`connect.${key}.title`)}</h2>
        <p className="connection-card__why">{t(`connect.${key}.why`)}</p>
        <p className="connection-card__next">{t(`connect.${key}.next`)}</p>
        <button type="button" className="btn btn-ghost connection-card__dismiss" onClick={onDismiss}>
          {t("connect.dismiss")}
        </button>
      </div>
    </article>
  );
}
