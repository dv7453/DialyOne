import { useCallback, useEffect, useRef, useState } from "react";
import {
  answerAskHuman,
  fetchApprovals,
  fetchHealth,
  resolveApproval,
  sendChat,
  speakVoice,
  transcribeVoice,
} from "./lib/brain";
import {
  isAuthed,
  loadSessionId,
  loadSettings,
  saveSessionId,
  saveSettings,
  setAuthed,
  type WebSettings,
} from "./lib/settings";
import type {
  ApprovalRecord,
  AskHumanState,
  ChatAttachment,
  ChatMessage,
  ResolvedApproval,
  VoicePhase,
} from "./types";
import { ApprovalCard } from "./components/ApprovalCard";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { LoginGate } from "./components/LoginGate";
import { MessageList } from "./components/MessageList";
import { ResolvedApprovalCard } from "./components/ResolvedApprovalCard";
import { ShareSheet } from "./components/ShareSheet";
import { VoiceBar } from "./components/VoiceBar";

function pendingBanner(n: number): string {
  return n === 1 ? "One thing needs you." : `${n} things need you.`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function wantsShare(text: string): boolean {
  return /\b(this|that)\s+(email|file|doc|pdf|attachment|message)\b/i.test(text);
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
    summary: `${Math.round(file.size / 1024)} KB — binary; Dialy got the filename only.`,
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

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [authed, setAuthedState] = useState(isAuthed);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [brainOk, setBrainOk] = useState(false);
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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const voiceActiveRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const health = await fetchHealth(settings);
      setBrainOk(Boolean(health.bootOk));
      const pending = await fetchApprovals(settings);
      setApprovals(pending);
      setError(null);
    } catch (e) {
      setBrainOk(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [settings]);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const t = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(t);
  }, [authed, refresh]);

  async function handleLogin() {
    setLoginBusy(true);
    setLoginError(null);
    const next: WebSettings = {
      brainUrl: settings.brainUrl.replace(/\/+$/, ""),
      brainToken: settings.brainToken,
    };
    saveSettings(next);
    setSettings(next);
    try {
      const health = await fetchHealth(next);
      if (!health.bootOk) throw new Error("Brain is not ready yet.");
      setAuthed(true);
      setAuthedState(true);
      setBrainOk(true);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  }

  function handleSignOut() {
    stopVoice(true);
    setAuthed(false);
    setAuthedState(false);
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
      text: text || "(attachment)",
      at: now,
      attachment: attachments?.[0],
    };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setPendingAttach(null);
    setChatBusy(true);
    setError(null);

    if (attachments?.length) {
      setWaitingShare(false);
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          text: "Got it — what should I do?",
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
          text: "Send it over — I’m ready.",
          at: new Date().toISOString(),
        },
      ]);
    }

    try {
      if (opts.fromVoice) setVoicePhase("thinking");
      const result = await sendChat(settings, {
        sessionId,
        message: text || "Please use the attached content.",
        attachments,
      });
      setSessionId(result.sessionId);
      saveSessionId(result.sessionId);

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

      if (result.status !== "completed") {
        throw new Error(result.error ?? `Chat ${result.status}`);
      }

      const reply = result.text?.trim() || "(no reply)";
      setMessages((prev) => [
        ...prev,
        { id: uid("d"), role: "dialy", text: reply, at: new Date().toISOString() },
      ]);
      if (opts.fromVoice) await playTts(reply);
      else setVoicePhase("idle");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setVoicePhase("idle");
      voiceActiveRef.current = false;
    } finally {
      setChatBusy(false);
    }
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
      if (result.status !== "completed") {
        throw new Error(result.error ?? `Chat ${result.status}`);
      }
      setMessages((prev) => [
        ...prev,
        {
          id: uid("d"),
          role: "dialy",
          text: result.text?.trim() || "(no reply)",
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          text: decision === "approve" ? "You approved an action." : "You denied an action.",
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        stream.getTracks().forEach((t) => t.stop());
        void finishVoice(mime);
      };
      mediaRecorderRef.current = recorder;
      voiceActiveRef.current = true;
      setVoicePhase("listening");
      recorder.start();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone unavailable");
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
        setError("Didn’t catch that — try again.");
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
          ? "Here’s the attachment you asked for."
          : `Please look at this: ${file.name}`,
        attachments: [attachment],
      });
    } else {
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          text: `Attached ${file.name} — send a message when ready.`,
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
      text: waitingShare ? "Here’s what you asked for." : "Please use this pasted content.",
      attachments: [attachment],
    });
  }

  if (!authed) {
    return (
      <LoginGate
        token={settings.brainToken}
        brainUrl={settings.brainUrl}
        error={loginError}
        busy={loginBusy}
        onTokenChange={(v) => setSettings((s) => ({ ...s, brainToken: v }))}
        onBrainUrlChange={(v) => setSettings((s) => ({ ...s, brainUrl: v }))}
        onContinue={() => void handleLogin()}
      />
    );
  }

  const showEmpty =
    approvals.length === 0 &&
    messages.length === 0 &&
    resolved.length === 0 &&
    !waitingShare &&
    !pendingAttach;
  const voiceOpen = voicePhase !== "idle";

  return (
    <div className="app-shell">
      <Header brainOk={brainOk} onSignOut={handleSignOut} />
      <main className="main-scroll">
        {error ? <div className="error-banner">{error}</div> : null}
        {showEmpty ? <EmptyState /> : null}
        {approvals.length > 0 ? (
          <>
            <p className="pending-banner">{pendingBanner(approvals.length)}</p>
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
            Still waiting for that email.
          </div>
        ) : null}
        {pendingAttach && !chatBusy ? (
          <div className="attachment-card attachment-card--pending">
            <span className="material-symbols-outlined">draft</span>
            <div>
              <p className="attachment-card__name">{pendingAttach.name}</p>
              <p className="attachment-card__summary">Ready to send with your next message.</p>
            </div>
          </div>
        ) : null}
        <MessageList messages={messages} />
        {chatBusy && !voiceOpen ? (
          <div className="msg--system">
            <span className="material-symbols-outlined">hourglass_empty</span>
            Dialy is thinking…
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
      ) : (
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
        onPasteText={(t) => void handlePasteText(t)}
      />
    </div>
  );
}
