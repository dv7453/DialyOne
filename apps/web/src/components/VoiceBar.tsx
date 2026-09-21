import { useTranslation } from "react-i18next";
import type { VoicePhase } from "../types";

type Props = {
  phase: VoicePhase;
  onStop: () => void;
};

export function VoiceBar({ phase, onStop }: Props) {
  const { t } = useTranslation();
  if (phase === "idle") return null;

  return (
    <div className="voice-bar">
      <div className={`voice-bar__pulse voice-bar__pulse--${phase}`} aria-hidden />
      <span className="voice-bar__label">{t(`voice.${phase}`)}</span>
      <button type="button" className="btn btn-ghost voice-bar__stop" onClick={onStop}>
        {t("voice.stop")}
      </button>
    </div>
  );
}
