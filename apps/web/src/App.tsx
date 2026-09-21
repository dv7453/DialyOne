import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  answerAskHuman,
  exchangeLoginToken,
  fetchApprovals,
  fetchCapabilities,
  fetchHealth,
  fetchMe,
  logoutSession,
  requestMagicLink,
  resolveApproval,
  sendChat,
  speakVoice,
  transcribeVoice,
} from "./lib/brain";
import {
  isConnectorLive,
  parseUnavailableConnection,
  type NeededConnection,
} from "./lib/connections";
import { isBrainHttpError } from "./lib/errors";
import { hasCompletedFirstRun, markFirstRunComplete } from "./lib/first-run";
import { i18n, setAppLocale } from "./lib/i18n";
import { pushAppPath, readAppLocation, replaceAppPath, type AppView } from "./lib/routing";
import {
  clearAuthSettings,
  isAuthed,
  loadSessionId,
  loadSettings,
  saveSessionId,
  saveSettings,
  type WebSettings,
} from "./lib/settings";
import type {
  AdapterFlags,
  ApprovalRecord,
  AskHumanState,
  ChatAttachment,
  ChatMessage,
  MeUser,
  ResolvedApproval,
  VoicePhase,
} from "./types";
import { ApprovalCard } from "./components/ApprovalCard";
import { Composer } from "./components/Composer";
import { ConnectionCard } from "./components/ConnectionCard";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { LoginGate, type LoginMode } from "./components/LoginGate";
import { MessageList } from "./components/MessageList";
import { ResolvedApprovalCard } from "./components/ResolvedApprovalCard";
import { SettingsPanel } from "./components/SettingsPanel";
import { ShareSheet } from "./components/ShareSheet";
import { VoiceBar } from "./components/VoiceBar";
import { AccessPage } from "./components/AccessPage";

const CallView = lazy(async () => {
  const mod = await import("./components/CallView");
  return { default: mod.CallView };
});

const PENDING_LOGIN_TOKEN = "dialy.web.pending-login-token";

function CallFallback() {
  const { t } = useTranslation();
  return (
    <div className="call-view">
      <div className="empty-state">
        <div className="empty-state__icon" aria-hidden>
          <span className="voice-bar__pulse" />
        </div>
        <h1 className="empty-state__headline">{t("call.status.connecting")}</h1>
      </div>
    </div>
  );
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const SHARE_INTENT = [
  /\b(this|that)\s+(email|file|doc|pdf|attachment|message)\b/i,
  /(ઈમેલ|ઇમેલ|મેઇલ|ફાઇલ|ફાઈલ|દસ્તાવેજ|જોડાણ|સંદેશ|મેસેજ)/,
];

function wantsShare(text: string): boolean {
  return SHARE_INTENT.some((pattern) => pattern.test(text));
}

async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const mimeType = file.type || undefined;
  const isText =
    !mimeType ||
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    /\.(eml|txt|md|json|csv)$/i.test(file.name);

  if (isText && file.size < 400_000) {
    const text = await file.text();
    return {
      name: file.name,
      mimeType,
      text: text.slice(0, 80_000),
      summary: text.slice(0, 160).replace(/\s+/g, " "),
    };
  }
  return {
    name: file.name,
    mimeType,
    summary: i18n.t("chat.binaryAttachmentSummary", {
      size: Math.round(file.size / 1024),
    }),
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const i = dataUrl.indexOf(",");
      resolve(i >= 0 ? dataUrl.slice(i + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function takePendingLoginToken(): string | null {
  const fromUrl = readAppLocation().loginToken;
  if (fromUrl) {
    sessionStorage.setItem(PENDING_LOGIN_TOKEN, fromUrl);
    replaceAppPath("/");
    return fromUrl;
  }
  return sessionStorage.getItem(PENDING_LOGIN_TOKEN);
}

function loginCopyKey(error: unknown): string {
  if (error instanceof TypeError) return "login.brainUnreachable";
  if (!isBrainHttpError(error)) return "login.sessionFailed";
  if (error.status === 429 || error.code === "rate_limited") return "login.rateLimited";
  if (error.code === "invalid_email") return "login.invalidEmail";
  if (error.code === "auth_unavailable" || error.status === 503) return "login.authUnavailable";
  if (error.status >= 500) return "login.brainUnreachable";
  return "login.sessionFailed";
}

export default function App() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(loadSettings);
  const [authed, setAuthedState] = useState(() => isAuthed(loadSettings()));
  const [me, setMe] = useState<MeUser | null>(null);
  const [loginMode, setLoginMode] = useState<LoginMode>(() =>
    readAppLocation().loginToken ? "exchanging" : "email",
  );
  const [loginEmail, setLoginEmail] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [brainOk, setBrainOk] = useState(false);
  const [flags, setFlags] = useState<AdapterFlags | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [resolved, setResolved] = useState<ResolvedApproval[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(loadSessionId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askHuman, setAskHuman] = useState<AskHumanState | null>(null);
  const [waitingShare, setWaitingShare] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [pendingAttach, setPendingAttach] = useState<ChatAttachment | null>(null);
  const [callOpen, setCallOpen] = useState(false);
  const [view, setView] = useState<AppView>(() => readAppLocation().view);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [neededConnection, setNeededConnection] = useState<NeededConnection | null>(null);
  const [firstRun, setFirstRun] = useState(() => !hasCompletedFirstRun());

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceActiveRef = useRef(false);
  const mainScrollRef = useRef<HTMLElement | null>(null);

  const persistSettings = useCallback((next: WebSettings) => {
    saveSettings(next);
    setSettings(next);
  }, []);

  const enterAuthed = useCallback(
    (next: WebSettings, user: MeUser | null) => {
      persistSettings(next);
      setMe(user);
      setAuthedState(true);
      setLoginBusy(false);
      setLoginError(null);
      setLoginMode("email");
      replaceAppPath("/");
      setView("chat");
      setFirstRun(!hasCompletedFirstRun());
    },
    [persistSettings],
  );

  const refresh = useCallback(async () => {
    try {
      const health = await fetchHealth(settings);
      setBrainOk(Boolean(health.bootOk));
      const pending = await fetchApprovals(settings);
      setApprovals(pending);
      setError(null);
      try {
        const caps = await fetchCapabilities(settings);
        setFlags(caps.flags);
      } catch {
        /* capabilities are optional for the chat surface */
      }
    } catch (e) {
      if (isBrainHttpError(e) && e.status === 401 && settings.authKind === "session") {
        persistSettings(clearAuthSettings(settings));
        setAuthedState(false);
        setMe(null);
        setLoginMode("email");
        return;
      }
      setBrainOk(false);
      setError(
        e instanceof TypeError || (isBrainHttpError(e) && e.status >= 500)
          ? t("login.brainUnreachable")
          : e instanceof Error
            ? e.message
            : String(e),
      );
    }
  }, [persistSettings, settings]);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const interval = setInterval(() => void refresh(), callOpen ? 4_000 : 12_000);
    return () => clearInterval(interval);
  }, [authed, refresh, callOpen]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    void fetchMe(settings)
      .then((user) => {
        if (!cancelled) setMe(user);
      })
      .catch(() => {
        /* static-token lab sessions may have no /v1/me user */
      });
    return () => {
      cancelled = true;
    };
  }, [authed, settings]);

  useEffect(() => {
    function onPop() {
      setView(readAppLocation().view);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const token = takePendingLoginToken();
    if (!token) return;
    sessionStorage.removeItem(PENDING_LOGIN_TOKEN);
    setLoginMode("exchanging");
    setLoginBusy(true);
    const next: WebSettings = {
      ...settings,
      brainUrl: settings.brainUrl.replace(/\/+$/, ""),
    };
    void (async () => {
      try {
        const session = await exchangeLoginToken(next, token);
        const authedSettings: WebSettings = {
          ...next,
          brainToken: session.token,
          authKind: "session",
        };
        let user: MeUser | null = {
          id: session.user.id,
          email: session.user.email,
          displayName: session.user.displayName,
          locale: session.user.locale,
          auth: "session",
        };
        try {
          user = await fetchMe(authedSettings);
        } catch {
          /* session body is enough */
        }
        enterAuthed(authedSettings, user);
      } catch (e) {
        setLoginBusy(false);
        if (isBrainHttpError(e) && (e.code === "invalid_token" || e.status === 401)) {
          setLoginMode("invalid");
          setLoginError(null);
          return;
        }
        setLoginMode("email");
        setLoginError(t(loginCopyKey(e)));
      }
    })();
    // Login token is consumed once on first mount; settings are read from the
    // closure on purpose so a later settings edit cannot retrigger exchange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSendLink() {
    setLoginBusy(true);
    setLoginError(null);
    const email = loginEmail.trim();
    if (!email || !email.includes("@")) {
      setLoginError(t("login.invalidEmail"));
      setLoginBusy(false);
      return;
    }
    const next: WebSettings = {
      ...settings,
      brainUrl: settings.brainUrl.replace(/\/+$/, ""),
    };
    persistSettings(next);
    try {
      await requestMagicLink(next, email);
      setLoginMode("sent");
    } catch (e) {
      setLoginError(t(loginCopyKey(e)));
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLabLogin() {
    setLoginBusy(true);
    setLoginError(null);
    const next: WebSettings = {
      ...settings,
      brainUrl: settings.brainUrl.replace(/\/+$/, ""),
      authKind: "static",
    };
    persistSettings(next);
    try {
      const health = await fetchHealth(next);
      if (!health.bootOk) throw new Error(t("login.brainNotReady"));
      let user: MeUser | null = null;
      try {
        user = await fetchMe(next);
      } catch {
        user = null;
      }
      setBrainOk(true);
      enterAuthed(next, user);
    } catch (e) {
      persistSettings({ ...next, authKind: "none" });
      setLoginError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  }

  function handleSignOut() {
    stopVoice(true);
    setCallOpen(false);
    setSettingsOpen(false);
    void logoutSession(settings).catch(() => undefined);
    persistSettings(clearAuthSettings(settings));
    setAuthedState(false);
    setMe(null);
    setLoginMode("email");
    replaceAppPath("/");
    setView("chat");
  }

  function handleDeleted() {
    handleSignOut();
  }

  function finishFirstRun() {
    markFirstRunComplete();
    setFirstRun(false);
    mainScrollRef.current?.scrollTo({ top: 0 });
  }

  function handleFirstAction(id: "followUp" | "waiting") {
    finishFirstRun();
    if (id === "followUp") {
      if (!isConnectorLive(flags, "mail")) {
        setNeededConnection({ connector: "mail", capability: "mail.draft", source: "first_run" });
        return;
      }
      void runChat({ text: t("firstRun.actionFollowUp") });
      return;
    }
    void runChat({ text: t("firstRun.actionWaiting") });
  }

  function noteUnavailable(message: string) {
    const parsed = parseUnavailableConnection(message);
    if (parsed) {
      setNeededConnection({
        connector: parsed.connector,
        capability: parsed.capability,
        source: "action",
      });
    }
  }

  async function playTts(text: string) {
    try {
      setVoicePhase("speaking");
      const { audioBase64, mimeType } = await speakVoice(settings, text.slice(0, 4000));
      const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeType || "audio/mpeg" }));
      const audio = new Audio(url);
      audioRef.current = audio;
      await audio.play();
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
      });
      URL.revokeObjectURL(url);
    } catch {
      // TTS optional — chat reply still shows
    } finally {
      if (voiceActiveRef.current) setVoicePhase("idle");
      else setVoicePhase("idle");
      voiceActiveRef.current = false;
    }
  }

  async function runChat(opts: {
    text: string;
    attachments?: ChatAttachment[];
    fromVoice?: boolean;
  }) {
    const text = opts.text.trim();
    const attachments = opts.attachments?.length
      ? opts.attachments
      : pendingAttach
        ? [pendingAttach]
        : undefined;

    if (!text && !attachments?.length) return;
    if (askHuman) {
      await answerPendingAsk(text);
      return;
    }

    const now = new Date().toISOString();
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      text: text || t("chat.attachmentFallback"),
      at: now,
      attachment: attachments?.[0],
    };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setPendingAttach(null);
    setChatBusy(true);
    setError(null);
    finishFirstRun();

    if (attachments?.length) {
      setWaitingShare(false);
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          text: t("chat.gotAttachment"),
          at: new Date().toISOString(),
        },
      ]);
    } else if (wantsShare(text)) {
      setWaitingShare(true);
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          text: t("chat.sendItOver"),
          at: new Date().toISOString(),
        },
      ]);
    }

    try {
      if (opts.fromVoice) setVoicePhase("thinking");
      const result = await sendChat(settings, {
        sessionId,
        message: text || t("chat.useAttachedContent"),
        attachments,
      });
      setSessionId(result.sessionId);
      saveSessionId(result.sessionId);

      if (result.error) noteUnavailable(result.error);

      if (result.status === "ask_human" && result.askHuman) {
        setAskHuman({
          sessionId: result.sessionId,
          turnId: result.turnId,
          toolCallId: result.askHuman.toolCallId,
          query: result.askHuman.query,
          options: result.askHuman.options,
        });
        setMessages((prev) => [
          ...prev,
          {
            id: uid("d"),
            role: "dialy",
            text: result.askHuman!.query,
            at: new Date().toISOString(),
          },
        ]);
        if (opts.fromVoice) await playTts(result.askHuman.query);
        else setVoicePhase("idle");
        return;
      }

      if (result.status === "suspended") {
        await announceAwaitingApproval(opts.fromVoice);
        return;
      }

      if (result.status !== "completed") {
        const fail = result.error ?? `Chat ${result.status}`;
        noteUnavailable(fail);
        throw new Error(fail);
      }

      const reply = result.text?.trim() || t("chat.noReply");
      setMessages((prev) => [
        ...prev,
        { id: uid("d"), role: "dialy", text: reply, at: new Date().toISOString() },
      ]);
      if (opts.fromVoice) await playTts(reply);
      else setVoicePhase("idle");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      noteUnavailable(message);
      setError(message);
      setVoicePhase("idle");
      voiceActiveRef.current = false;
    } finally {
      setChatBusy(false);
    }
  }

  /**
   * A suspended turn is the approval flow working, not a failure: the brain has
   * minted a card and is waiting. Pull the approvals list immediately so the card
   * lands with the message instead of up to a poll interval later.
   */
  async function announceAwaitingApproval(fromVoice?: boolean) {
    const notice = t("approvals.awaiting");
    setMessages((prev) => [
      ...prev,
      { id: uid("d"), role: "dialy", text: notice, at: new Date().toISOString() },
    ]);
    await refresh();
    if (fromVoice) await playTts(notice);
    else setVoicePhase("idle");
  }

  async function answerPendingAsk(text: string) {
    if (!askHuman || !text.trim()) return;
    setChatBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: uid("u"), role: "user", text: text.trim(), at: new Date().toISOString() },
    ]);
    setDraft("");
    try {
      const result = await answerAskHuman(settings, {
        sessionId: askHuman.sessionId,
        turnId: askHuman.turnId,
        toolCallId: askHuman.toolCallId,
        text: text.trim(),
      });
      setAskHuman(null);
      if (result.error) noteUnavailable(result.error);
      if (result.status === "ask_human" && result.askHuman) {
        setAskHuman({
          sessionId: result.sessionId,
          turnId: result.turnId,
          toolCallId: result.askHuman.toolCallId,
          query: result.askHuman.query,
          options: result.askHuman.options,
        });
        setMessages((prev) => [
          ...prev,
          {
            id: uid("d"),
            role: "dialy",
            text: result.askHuman!.query,
            at: new Date().toISOString(),
          },
        ]);
        return;
      }
      if (result.status === "suspended") {
        await announceAwaitingApproval(false);
        return;
      }
      if (result.status !== "completed") {
        const fail = result.error ?? `Chat ${result.status}`;
        noteUnavailable(fail);
        throw new Error(fail);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: uid("d"),
          role: "dialy",
          text: result.text?.trim() || t("chat.noReply"),
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      noteUnavailable(message);
      setError(message);
    } finally {
      setChatBusy(false);
    }
  }

  async function handleResolve(approval: ApprovalRecord, decision: "approve" | "deny") {
    setBusyId(approval.id);
    try {
      const result = await resolveApproval(settings, approval.id, decision);
      setResolved((prev) => [result, ...prev].slice(0, 20));
      setApprovals((prev) => prev.filter((a) => a.id !== approval.id));
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          text: decision === "approve" ? t("approvals.youApproved") : t("approvals.youDenied"),
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      noteUnavailable(message);
      setError(message);
    } finally {
      setBusyId(null);
    }
  }

  function stopVoice(abort = false) {
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    mediaRecorderRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    if (abort) {
      voiceActiveRef.current = false;
      setVoicePhase("idle");
    }
  }

  async function startVoice() {
    if (chatBusy || voicePhase !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void finishVoice(mime);
      };
      mediaRecorderRef.current = recorder;
      voiceActiveRef.current = true;
      setVoicePhase("listening");
      recorder.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("voice.micUnavailable"));
      setVoicePhase("idle");
    }
  }

  async function finishVoice(mimeType: string) {
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (blob.size < 200) {
      setVoicePhase("idle");
      voiceActiveRef.current = false;
      return;
    }
    try {
      setVoicePhase("thinking");
      const audioBase64 = await blobToBase64(blob);
      const { transcript } = await transcribeVoice(settings, audioBase64, mimeType);
      const text = transcript.trim();
      if (!text) {
        setVoicePhase("idle");
        voiceActiveRef.current = false;
        setError(t("voice.didntCatch"));
        return;
      }
      await runChat({ text, fromVoice: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVoicePhase("idle");
      voiceActiveRef.current = false;
    }
  }

  async function handlePickFile(file: File) {
    setShareOpen(false);
    const attachment = await fileToAttachment(file);
    setPendingAttach(attachment);
    if (waitingShare || messages.length > 0 || voicePhase !== "idle") {
      await runChat({
        text: waitingShare
          ? t("chat.heresAttachment")
          : t("chat.pleaseLookAt", { name: file.name }),
        attachments: [attachment],
      });
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          text: t("chat.attachedReady", { name: file.name }),
          at: new Date().toISOString(),
        },
      ]);
    }
  }

  async function handlePasteText(text: string) {
    setShareOpen(false);
    const attachment: ChatAttachment = {
      name: "pasted.txt",
      mimeType: "text/plain",
      text,
      summary: text.slice(0, 120).replace(/\s+/g, " "),
    };
    setPendingAttach(attachment);
    await runChat({
      text: waitingShare ? t("chat.heresPasted") : t("chat.usePasted"),
      attachments: [attachment],
    });
  }

  function openAccess() {
    pushAppPath("/access");
    setView("access");
  }

  function closeAccess() {
    replaceAppPath("/");
    setView("chat");
  }

  if (!authed) {
    return (
      <LoginGate
        mode={loginMode}
        email={loginEmail}
        token={settings.brainToken}
        brainUrl={settings.brainUrl}
        locale={settings.locale}
        error={loginError}
        busy={loginBusy}
        onEmailChange={setLoginEmail}
        onTokenChange={(v) => setSettings((s) => ({ ...s, brainToken: v }))}
        onBrainUrlChange={(v) => setSettings((s) => ({ ...s, brainUrl: v }))}
        onLocaleChange={(locale) => {
          setAppLocale(locale);
          setSettings((s) => ({ ...s, locale }));
        }}
        onSendLink={() => void handleSendLink()}
        onLabContinue={() => void handleLabLogin()}
        onUseDifferentEmail={() => {
          setLoginMode("email");
          setLoginError(null);
        }}
        onRequestNewLink={() => {
          setLoginMode("email");
          setLoginError(null);
        }}
        onShowLab={() => {
          setLoginMode("lab");
          setLoginError(null);
        }}
        onHideLab={() => {
          setLoginMode("email");
          setLoginError(null);
        }}
      />
    );
  }

  const showEmpty =
    approvals.length === 0 &&
    messages.length === 0 &&
    resolved.length === 0 &&
    !waitingShare &&
    !pendingAttach &&
    !neededConnection;
  const voiceOpen = voicePhase !== "idle";

  if (callOpen) {
    return (
      <Suspense fallback={<CallFallback />}>
        <CallView
          settings={settings}
          sessionId={sessionId}
          approvals={approvals}
          resolved={resolved}
          busyId={busyId}
          onSettingsChange={(next) => {
            persistSettings(next);
          }}
          onSession={(id) => {
            setSessionId(id);
            saveSessionId(id);
          }}
          onResolve={(approval, decision) => void handleResolve(approval, decision)}
          onClose={() => setCallOpen(false)}
        />
      </Suspense>
    );
  }

  if (view === "access") {
    return (
      <>
        <AccessPage settings={settings} me={me} onClose={closeAccess} />
        {settingsOpen ? (
          <SettingsPanel
            settings={settings}
            me={me}
            onSave={persistSettings}
            onClose={() => setSettingsOpen(false)}
            onSignOut={handleSignOut}
            onDeleted={handleDeleted}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="app-shell">
      <Header
        brainOk={brainOk}
        onCall={() => setCallOpen(true)}
        onAccess={openAccess}
        onSettings={() => setSettingsOpen(true)}
      />
      <main className="main-scroll" ref={mainScrollRef}>
        {error ? <div className="error-banner">{error}</div> : null}
        {showEmpty ? (
          <EmptyState
            firstRun={firstRun}
            onCall={() => setCallOpen(true)}
            onFirstAction={handleFirstAction}
            onSkipFirstRun={finishFirstRun}
          />
        ) : null}
        {neededConnection ? (
          <ConnectionCard needed={neededConnection} onDismiss={() => setNeededConnection(null)} />
        ) : null}
        {approvals.length > 0 ? (
          <>
            <p className="pending-banner">
              {t("approvals.pendingBanner", { count: approvals.length })}
            </p>
            {approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                busy={busyId === a.id}
                onResolve={(d) => void handleResolve(a, d)}
              />
            ))}
          </>
        ) : null}
        {resolved.map((r, i) => (
          <ResolvedApprovalCard key={`${r.approval.id}-${i}`} item={r} />
        ))}
        {waitingShare ? (
          <div className="msg--system">
            <span className="material-symbols-outlined">mark_email_unread</span>
            {t("chat.waitingShare")}
          </div>
        ) : null}
        {pendingAttach && !chatBusy ? (
          <div className="attachment-card attachment-card--pending">
            <span className="material-symbols-outlined">draft</span>
            <div>
              <p className="attachment-card__name">{pendingAttach.name}</p>
              <p className="attachment-card__summary">{t("chat.readyToSend")}</p>
            </div>
          </div>
        ) : null}
        <MessageList messages={messages} />
        {chatBusy && !voiceOpen ? (
          <div className="msg--system">
            <span className="material-symbols-outlined">hourglass_empty</span>
            {t("chat.thinking")}
          </div>
        ) : null}
      </main>
      {voiceOpen ? (
        <VoiceBar
          phase={voicePhase}
          onStop={() => {
            if (voicePhase === "listening") stopVoice(false);
            else stopVoice(true);
          }}
        />
      ) : firstRun && showEmpty ? null : (
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void runChat({ text: draft })}
          onMic={() => void startVoice()}
          onAttach={() => setShareOpen(true)}
          disabled={!brainOk || chatBusy}
          canAttach
        />
      )}
      <ShareSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onPickFile={(f) => void handlePickFile(f)}
        onPasteText={(pasted) => void handlePasteText(pasted)}
      />
      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          me={me}
          onSave={persistSettings}
          onClose={() => setSettingsOpen(false)}
          onSignOut={handleSignOut}
          onDeleted={handleDeleted}
        />
      ) : null}
    </div>
  );
}
