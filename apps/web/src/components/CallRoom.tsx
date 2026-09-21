import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  RoomAudioRenderer,
  useConnectionState,
  useLocalParticipant,
  useMultibandTrackVolume,
  useRoomContext,
  useTrackTranscription,
  useTrackToggle,
  useTranscriptions,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState, LocalAudioTrack, Track } from "livekit-client";
import type { ApprovalRecord, ResolvedApproval } from "../types";
import { ApprovalCard } from "./ApprovalCard";
import { ResolvedApprovalCard } from "./ResolvedApprovalCard";

type RoomPhase = "connecting" | "connected" | "reconnecting";

type TranscriptLine = {
  id: string;
  role: "user" | "dialy";
  text: string;
  final: boolean;
  at: number;
};

type Props = {
  approvals: ApprovalRecord[];
  resolved: ResolvedApproval[];
  busyId: string | null;
  micBlocked: boolean;
  onPhase: (phase: RoomPhase) => void;
  onResolve: (approval: ApprovalRecord, decision: "approve" | "deny") => void;
  onMicRecovered: () => void;
};

function mapPhase(state: ConnectionState): RoomPhase {
  if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
    return "reconnecting";
  }
  if (state === ConnectionState.Connected) return "connected";
  return "connecting";
}

export function CallRoom({
  approvals,
  resolved,
  busyId,
  micBlocked,
  onPhase,
  onResolve,
  onMicRecovered,
}: Props) {
  const { t } = useTranslation();
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const phase = mapPhase(connectionState);
  const { localParticipant, microphoneTrack, isMicrophoneEnabled } = useLocalParticipant();
  const { toggle: toggleMic, pending: micPending } = useTrackToggle({
    source: Track.Source.Microphone,
  });
  const { state: agentState, agentTranscriptions } = useVoiceAssistant();
  const localTrack = microphoneTrack?.track;
  const localAudio = localTrack instanceof LocalAudioTrack ? localTrack : undefined;
  const { segments: userSegments } = useTrackTranscription(
    microphoneTrack
      ? {
          participant: localParticipant,
          publication: microphoneTrack,
          source: Track.Source.Microphone,
        }
      : undefined,
  );
  const streams = useTranscriptions();
  const bands = useMultibandTrackVolume(localAudio, { bands: 5, updateInterval: 40 });
  const muted = !isMicrophoneEnabled;
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onPhase(phase);
  }, [onPhase, phase]);

  const lines = useMemo(() => {
    const fromTracks: TranscriptLine[] = [
      ...userSegments.map((segment) => ({
        id: segment.id,
        role: "user" as const,
        text: segment.text,
        final: segment.final,
        at: segment.firstReceivedTime,
      })),
      ...agentTranscriptions.map((segment) => ({
        id: segment.id,
        role: "dialy" as const,
        text: segment.text,
        final: segment.final,
        at: segment.firstReceivedTime,
      })),
    ].filter((line) => line.text.trim());

    if (fromTracks.length > 0) {
      return fromTracks.sort((a, b) => a.at - b.at);
    }

    const localId = localParticipant.identity;
    return streams
      .filter((stream) => stream.text.trim())
      .map((stream) => ({
        id: stream.streamInfo.id,
        role: (stream.participantInfo.identity === localId ? "user" : "dialy") as "user" | "dialy",
        text: stream.text,
        final: stream.streamInfo.attributes?.["lk.transcription_final"] !== "false",
        at: stream.streamInfo.timestamp,
      }))
      .sort((a, b) => a.at - b.at);
  }, [agentTranscriptions, localParticipant.identity, streams, userSegments]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, approvals.length]);

  const agentListening =
    agentState === "listening" || agentState === "idle" || agentState === "pre-connect-buffering";
  const statusText = muted
    ? t("call.muted")
    : phase === "reconnecting"
      ? t("call.status.reconnecting")
      : phase === "connecting"
        ? t("call.connectingHint")
        : agentState === "speaking"
          ? t("call.speaking")
          : agentState === "thinking"
            ? t("call.thinking")
            : agentState === "failed"
              ? t("call.agentFailed")
              : agentListening
                ? t("call.listening")
                : t("call.waitingAgent");

  async function retryMic() {
    try {
      await localParticipant.setMicrophoneEnabled(true);
      onMicRecovered();
    } catch {
      /* stay blocked — retry remains */
    }
  }

  return (
    <div className={`call-session call-session--${phase}`}>
      <RoomAudioRenderer />
      {phase === "reconnecting" ? (
        <div className="call-banner call-banner--reconnect" role="status">
          <span className="call-pip call-pip--pulse" aria-hidden />
          {t("call.reconnectingHint")}
        </div>
      ) : null}
      {micBlocked ? (
        <div className="call-banner call-banner--mic" role="alert">
          <p className="call-banner__title">{t("call.micWhyTitle")}</p>
          <p>{t("call.micBlockedLive")}</p>
          <button type="button" className="btn btn-ghost" onClick={() => void retryMic()}>
            {t("call.micRetry")}
          </button>
        </div>
      ) : null}

      <div className="call-session__scroll">
        {approvals.length > 0 ? (
          <div className="call-approvals">
            <p className="pending-banner">{t("call.approvalsTitle")}</p>
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                busy={busyId === approval.id}
                onResolve={(decision) => onResolve(approval, decision)}
              />
            ))}
          </div>
        ) : null}
        {resolved.map((item, index) => (
          <ResolvedApprovalCard key={`${item.approval.id}-${index}`} item={item} />
        ))}

        <div className="messages call-transcript" aria-live="polite">
          {lines.length === 0 ? (
            <div className="msg--system">
              <span className="material-symbols-outlined">graphic_eq</span>
              {t("call.transcriptEmpty")}
            </div>
          ) : (
            lines.map((line) =>
              line.role === "user" ? (
                <div
                  key={line.id}
                  className={`msg-user-wrap${line.final ? "" : " is-interim"}`}
                >
                  <span className="call-line__who">{t("call.you")}</span>
                  <div className="msg--user">{line.text}</div>
                </div>
              ) : (
                <div key={line.id} className={`msg--dialy${line.final ? "" : " is-interim"}`}>
                  <div className="msg--dialy-avatar" aria-hidden>
                    <span className="material-symbols-outlined">auto_awesome</span>
                  </div>
                  <div className="msg-dialy-body">
                    <span className="call-line__who">{t("brand.name")}</span>
                    <div className="msg--dialy-text">{line.text}</div>
                  </div>
                </div>
              ),
            )
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="call-dock">
        <div className="call-meter-row">
          <div
            className={`call-meter${muted ? " is-muted" : ""}${agentListening && !muted ? " is-listening" : ""}${agentState === "speaking" ? " is-agent" : ""}`}
            aria-hidden
          >
            {(bands.length ? bands : [0.15, 0.25, 0.4, 0.25, 0.15]).map((band, index) => (
              <span
                key={index}
                className="call-meter__bar"
                style={{ height: `${Math.max(4, Math.round(Math.min(1, band) * 28))}px` }}
              />
            ))}
          </div>
          <p className="call-meter-row__label" aria-live="polite">
            {statusText}
          </p>
        </div>
        <div className="call-controls">
          <div className="call-controls__wrap">
            <button
              type="button"
              className={`call-controls__btn call-controls__btn--mute${muted ? " is-on" : ""}`}
              disabled={micPending}
              onClick={() => void toggleMic()}
              aria-label={muted ? t("call.unmute") : t("call.mute")}
            >
              <span className="material-symbols-outlined">{muted ? "mic_off" : "mic"}</span>
            </button>
            <span className="call-controls__label">{muted ? t("call.unmute") : t("call.mute")}</span>
          </div>
          <div className="call-controls__wrap">
            <button
              type="button"
              className="call-controls__btn call-controls__btn--end"
              onClick={() => room.disconnect()}
              aria-label={t("call.end")}
            >
              <span className="material-symbols-outlined">call_end</span>
            </button>
            <span className="call-controls__label">{t("call.end")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
