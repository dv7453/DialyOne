import { useTranslation } from "react-i18next";

type Props = {
  open: boolean;
  onClose: () => void;
  onPickFile: (file: File) => void;
  onPasteText: (text: string) => void;
};

export function ShareSheet({ open, onClose, onPickFile, onPasteText }: Props) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div className="settings-overlay" role="dialog" aria-modal onClick={onClose}>
      <div
        className="settings-panel share-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-handle" />
        <div className="settings-panel__header">
          <h2 className="settings-panel__title">{t("share.title")}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="settings-panel__body">
          <label className="share-pick">
            <span className="material-symbols-outlined">attach_file</span>
            <span>{t("share.chooseFile")}</span>
            <input
              type="file"
              accept=".eml,.txt,.md,.pdf,image/*,text/*,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onPickFile(f);
              }}
            />
          </label>
          <button
            type="button"
            className="share-pick"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text.trim()) onPasteText(text.trim());
              } catch {
                const pasted = window.prompt(t("share.pastePrompt"));
                if (pasted?.trim()) onPasteText(pasted.trim());
              }
            }}
          >
            <span className="material-symbols-outlined">content_paste</span>
            <span>{t("share.pasteClipboard")}</span>
          </button>
          <p className="field__hint">{t("share.hint")}</p>
        </div>
      </div>
    </div>
  );
}
