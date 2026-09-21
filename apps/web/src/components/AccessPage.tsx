import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdapterFlags, JournalEntry, MeUser, PlaybookSummary, TrustRecord } from "../types";
import {
  capabilityLabel,
  fetchCapabilities,
  fetchJournal,
  fetchPlaybooks,
  fetchTrust,
  KNOWN_CAPABILITIES,
} from "../lib/brain";
import { CONNECTORS } from "../lib/connections";
import { isBrainHttpError, isNotImplemented } from "../lib/errors";
import type { WebSettings } from "../lib/settings";

type Props = {
  settings: WebSettings;
  me: MeUser | null;
  onClose: () => void;
};

function unreachable(error: unknown): boolean {
  return error instanceof TypeError || (isBrainHttpError(error) && error.status >= 500);
}

function journalLine(entry: JournalEntry): string {
  const data = entry.data;
  if (typeof data.summary === "string" && data.summary.trim()) return data.summary.trim();
  const parts = [entry.kind, entry.playbookId].filter(Boolean);
  return parts.join(" · ");
}

export function AccessPage({ settings, me, onClose }: Props) {
  const { t } = useTranslation();
  const [flags, setFlags] = useState<AdapterFlags | null>(null);
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [journal, setJournal] = useState<JournalEntry[] | null>(null);
  const [journalMissing, setJournalMissing] = useState(false);
  const [trust, setTrust] = useState<TrustRecord[] | null>(null);
  const [trustMissing, setTrustMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await fetchCapabilities(settings);
        if (!cancelled) setFlags(caps.flags);
      } catch (e) {
        if (!cancelled) setError(unreachable(e) ? t("login.brainUnreachable") : e instanceof Error ? e.message : String(e));
      }
      try {
        const books = await fetchPlaybooks(settings);
        if (!cancelled) setPlaybooks(books);
      } catch {
        if (!cancelled) setPlaybooks([]);
      }
      try {
        const entries = await fetchJournal(settings, 20);
        if (!cancelled) setJournal(entries);
      } catch (e) {
        if (!cancelled) {
          if (isNotImplemented(e)) setJournalMissing(true);
          else if (unreachable(e)) setError(t("login.brainUnreachable"));
          else setJournal([]);
        }
      }
      try {
        const records = await fetchTrust(settings);
        if (!cancelled) setTrust(records);
      } catch (e) {
        if (!cancelled) {
          if (isNotImplemented(e)) setTrustMissing(true);
          else if (unreachable(e)) setError(t("login.brainUnreachable"));
          else setTrust([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings]);

  const identity =
    me?.email ? t("access.signedInAs", { email: me.email }) : t("access.signedInLab");

  return (
    <div className="access-page">
      <header className="header">
        <div className="header__brand">
          <img src="/brand/dialy-mark.png" alt="" className="header__mark" />
          <span className="header__word">{t("access.title")}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.back")}>
          <span className="material-symbols-outlined">close</span>
        </button>
      </header>
      <main className="access-page__main">
        {error ? <div className="error-banner">{error}</div> : null}
        <p className="access-page__lede">{t("access.lede")}</p>
        <p className="access-page__identity">{identity}</p>

        <section className="access-section">
          <h2 className="access-section__title">{t("access.canDo")}</h2>
          {flags === null ? null : (
            <ul className="access-list">
              {KNOWN_CAPABILITIES.map((item) => {
                const ready =
                  item.id === "journal.log"
                    ? true
                    : item.flag === "notify"
                      ? Boolean(flags.telegram || flags.notify)
                      : Boolean(flags[item.flag]);
                return (
                  <li key={item.id} className="access-list__row">
                    <span>{capabilityLabel(item.id)}</span>
                    <span className={ready ? "access-pill access-pill--on" : "access-pill"}>
                      {ready ? t("access.ready") : t("access.needsConnection")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="access-section">
          <h2 className="access-section__title">{t("access.connections")}</h2>
          {flags === null ? null : (
            <ul className="access-list">
              {CONNECTORS.map((item) => {
                const on = Boolean(flags[item.flag]);
                return (
                  <li key={item.key} className="access-list__row">
                    <span className="access-list__left">
                      <span className="material-symbols-outlined" aria-hidden>
                        {item.icon}
                      </span>
                      {t(item.settingsKey)}
                    </span>
                    <span className={on ? "access-pill access-pill--on" : "access-pill"}>
                      {on ? t("settings.live") : t("settings.inactive")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="access-section">
          <h2 className="access-section__title">{t("access.playbooks")}</h2>
          {playbooks === null ? null : playbooks.length > 0 ? (
            <ul className="access-list">
              {playbooks.map((book) => (
                <li key={book.id} className="access-list__row">
                  <span>{book.title || book.id}</span>
                  <span className={book.enabled ? "access-pill access-pill--on" : "access-pill"}>
                    {book.enabled ? t("settings.live") : t("settings.inactive")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="access-section__empty">{t("access.playbooksEmpty")}</p>
          )}
        </section>

        <section className="access-section">
          <h2 className="access-section__title">{t("access.recent")}</h2>
          {journalMissing ? (
            <p className="access-section__empty">{t("access.recentUnavailable")}</p>
          ) : journal === null ? null : journal.length > 0 ? (
            <ul className="access-activity">
              {journal.slice(0, 12).map((entry, index) => (
                <li key={`${entry.ts}-${entry.kind}-${index}`}>
                  <time dateTime={entry.ts}>{formatWhen(entry.ts)}</time>
                  <span>{journalLine(entry)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="access-section__empty">{t("access.recentEmpty")}</p>
          )}
        </section>

        <section className="access-section">
          <h2 className="access-section__title">{t("access.trust")}</h2>
          {trustMissing ? (
            <p className="access-section__empty">{t("access.trustUnavailable")}</p>
          ) : trust === null ? null : trust.length > 0 ? (
            <ul className="access-list">
              {trust.map((record) => (
                <li key={`${record.playbookId}-${record.capability}`} className="access-list__row access-list__row--stack">
                  <span>
                    {capabilityLabel(record.capability)}
                    {record.playbookId ? ` · ${record.playbookId}` : ""}
                  </span>
                  <span className={record.autonomyGranted ? "access-pill access-pill--on" : "access-pill"}>
                    {record.autonomyGranted ? t("access.trustAutonomy") : t("access.trustAsks")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="access-section__empty">{t("access.trustEmpty")}</p>
          )}
        </section>
      </main>
    </div>
  );
}

function formatWhen(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}
