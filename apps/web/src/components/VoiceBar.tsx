import type { VoicePhase } from "../types";

type Props = {
  phase: VoicePhase;
  onStop: () => void;
};

const LABEL: Record<Exclude<VoicePhase, "idle">, string> = {
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

export function VoiceBar({ phase, onStop }: Props) {
  if (phase === "idle") return null;
  return (
    <div className="voice-bar">
      <div className={`voice-bar__pulse voice-bar__pulse--${phase}`} aria-hidden />
      <span className="voice-bar__label">{LABEL[phase]}</span>
      <button type="button" className="btn btn-ghost voice-bar__stop" onClick={onStop}>
        Stop
      </button>
    </div>
  );
}
