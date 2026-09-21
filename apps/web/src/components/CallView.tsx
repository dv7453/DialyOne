import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LiveKitRoom } from "@livekit/components-react";
import { MediaDeviceFailure } from "livekit-client";
import type { ApprovalRecord, ResolvedApproval } from "../types";
import {
  CALL_LANGUAGE_I18N,
  DEFAULT_CALL_LANGUAGE,
  type CallLanguage,
} from "../lib/call-language";
import { requestMicAccess } from "../lib/mic";
import { saveSettings, type WebSettings } from "../lib/settings";
import { fetchVoiceToken, VoiceTokenError, type VoiceToken } from "../lib/voice-token";
import { CallLanguageToggle } from "./CallLanguageToggle";
import { CallRoom } from "./CallRoom";

type Stage = "idle" | "joining" | "live" | "ended";
type RoomPhase = "connecting" | "connected" | "reconnecting";
type MicIssue = "denied" | "unavailable" | null;

type Props = {
  settings: WebSettings;
  sessionId: string | null;
  approvals: ApprovalRecord[];
  resolved: ResolvedApproval[];
  busyId: string | null;
  onSettingsChange: (next: WebSettings) => void;
  onSession: (sessionId: string) => void;
  onResolve: (approval: ApprovalRecord, decision: "approve" | "deny") => void;
  onClose: () => void;
};

function tokenErrorKey(error: unknown): string {
  if (error instanceof VoiceTokenError) {
    if (error.code === "rejected") return "call.tokenRejected";
    if (error.code === "invalid") return "call.tokenInvalid";
  }
  return "call.tokenFailed";
}

function phaseStatusKey(phase: Stage | RoomPhase): string {
  if (phase === "joining" || phase === "live" || phase === "connecting") {
    return "call.status.connecting";
  }
  if (phase === "connected") return "call.status.connected";
  if (phase === "reconnecting") return "call.status.reconnecting";
  if (phase === "ended") return "call.status.ended";
  return "call.status.idle";
}

export function CallView({
  settings,
  sessionId,
  approvals,
  resolved,
  busyId,
  onSettingsChange,
  onSession,
  onResolve,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("idle");
  const [language, setLanguage] = useState<CallLanguage>(
    settings.callLanguage ?? DEFAULT_CALL_LANGUAGE,
  );
  const [creds, setCreds] = useState<VoiceToken | null>(null);
  const [roomPhase, setRoomPhase] = useState<RoomPhase>("connecting");
  const [micIssue, setMicIssue] = useState<MicIssue>(null);
  const [micBlockedLive, setMicBlockedLive] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const visualPhase: Stage | RoomPhase =
    stage === "live" ? roomPhase : stage === "joining" ? "connecting" : stage;

  const handleLanguage = (next: CallLanguage) => {
    setLanguage(next);
    const updated = { ...settings, callLanguage: next };
    saveSettings(updated);
    onSettingsChange(updated);
  };

  const handlePhase = useCallback((phase: RoomPhase) => {
    setRoomPhase(phase);
  }, []);

  async function startCall() {
    setErrorKey(null);
    setMicIssue(null);
    setStage("joining");
    setRoomPhase("connecting");

    const mic = await requestMicAccess();
    if (!activeRef.current) return;
    if (mic !== "granted") {
      setMicIssue(mic);
      setStage("idle");
      return;
    }

    const roomName = `dialy-${Date.now()}`;
    const identity = `user-${Date.now()}`;
    try {
      const token = await fetchVoiceToken(settings, {
        roomName,
        identity,
        language,
        sessionId,
      });
      if (!activeRef.current) return;
      onSession(token.roomName || roomName);
      setCreds(token);
      setStage("live");
    } catch (error) {
      if (!activeRef.current) return;
      setErrorKey(tokenErrorKey(error));
      setStage("idle");
    }
  }

  function leaveSurface() {
    setCreds(null);
    setStage("idle");
    setMicBlockedLive(false);
    setErrorKey(null);
    onClose();
  }

  return (
    <div className={`call-view call-view--${visualPhase}`}>
      <header className="header">
        <div className="header__brand">
          <img src="/brand/dialy-mark.png" alt="" className="header__mark" />
          <span className="header__word">{t("brand.name")}</span>
          {visualPhase !== "idle" && visualPhase !== "ended" ? (
            <span
              className={`status-pip${visualPhase === "connected" ? " status-pip--ok" : ""}${visualPhase === "reconnecting" ? " status-pip--pulse" : ""}`}
              title={t(phaseStatusKey(visualPhase))}
              aria-label={t(phaseStatusKey(visualPhase))}
            />
          ) : null}
        </div>
        <div className="header__actions">
          <span className="call-lang-chip">{t(CALL_LANGUAGE_I18N[language])}</span>
          <button type="button" className="icon-btn" onClick={leaveSurface} aria-label={t("call.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </header>

      {errorKey ? <div className="error-banner call-view__error">{t(errorKey)}</div> : null}

      {stage === "live" && creds ? (
        <LiveKitRoom
          className="call-view__room"
          serverUrl={creds.serverUrl}
          token={creds.participantToken}
          connect
          audio
          video={false}
          onDisconnected={() => {
            setCreds(null);
            setMicBlockedLive(false);
            setStage("ended");
          }}
          onError={() => setErrorKey("call.tokenFailed")}
          onMediaDeviceFailure={(failure) => {
            if (failure === MediaDeviceFailure.PermissionDenied) {
              setMicBlockedLive(true);
            } else if (failure === MediaDeviceFailure.NotFound) {
              setMicIssue("unavailable");
              setMicBlockedLive(true);
            }
          }}
        >
          <CallRoom
            approvals={approvals}
            resolved={resolved}
            busyId={busyId}
            micBlocked={micBlockedLive}
            onPhase={handlePhase}
            onResolve={onResolve}
            onMicRecovered={() => setMicBlockedLive(false)}
          />
        </LiveKitRoom>
      ) : (
        <main className="call-view__main">
          {stage === "joining" ? (
            <div className="empty-state">
              <div className="empty-state__icon" aria-hidden>
                <span className="voice-bar__pulse" />
              </div>
              <h1 className="empty-state__headline">{t("call.status.connecting")}</h1>
              <p className="empty-state__sub">{t("call.connectingHint")}</p>
            </div>
          ) : null}

          {stage === "ended" ? (
            <div className="empty-state">
              <div className="empty-state__icon" aria-hidden>
                <span className="material-symbols-outlined">call_end</span>
              </div>
              <h1 className="empty-state__headline">{t("call.status.ended")}</h1>
              <p className="empty-state__sub">{t("call.endedHint")}</p>
              <div className="call-view__actions">
                <button type="button" className="btn btn-solid" onClick={() => void startCall()}>
                  {t("call.again")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={leaveSurface}>
                  {t("call.back")}
                </button>
              </div>
            </div>
          ) : null}

          {stage === "idle" ? (
            <div className="empty-state">
              <div className="empty-state__icon" aria-hidden>
                <span className="material-symbols-outlined">call</span>
              </div>
              <h1 className="empty-state__headline">{t("call.idleHeadline")}</h1>
              <p className="empty-state__sub">{t("call.idleSub")}</p>
              <p className="call-view__lang-label">{t("call.languageLabel")}</p>
              <CallLanguageToggle value={language} onChange={handleLanguage} />
              {micIssue ? (
                <div className="call-mic-help">
                  <p className="call-mic-help__title">{t("call.micWhyTitle")}</p>
                  <p>{t("call.micWhy")}</p>
                  <p>
                    {micIssue === "unavailable" ? t("call.micUnavailable") : t("call.micDenied")}
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void startCall()}
                  >
                    {t("call.micRetry")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-solid login-gate__cta call-view__start"
                  onClick={() => void startCall()}
                >
                  {t("call.start")}
                </button>
              )}
            </div>
          ) : null}
        </main>
      )}
    </div>
  );
}
