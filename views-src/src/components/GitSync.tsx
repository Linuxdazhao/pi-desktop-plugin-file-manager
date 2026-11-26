import { useLayoutEffect, useRef, useState } from "react";
import type { T } from "../i18n";
import type { SyncAction, SyncInfo, SyncRequest } from "../lib/gitWorkspace";
import { ContextMenu } from "./ContextMenu";
import { GitIcon } from "./GitIcons";

type Group = "pull" | "push" | "fetch";
type Option = { action: SyncAction; label: Parameters<T>[0]; choose?: boolean };
const groups: { id: Group; label: Parameters<T>[0]; options: Option[] }[] = [
  { id: "pull", label: "gitPull", options: [{ action: "pull", label: "gitPull" }, { action: "pullRebase", label: "gitPullRebase" }] },
  { id: "push", label: "gitPush", options: [{ action: "push", label: "gitPush" }, { action: "push", label: "gitPushTo", choose: true }, { action: "forcePush", label: "gitForcePush" }] },
  { id: "fetch", label: "gitFetch", options: [{ action: "fetch", label: "gitFetch" }, { action: "fetch", label: "gitFetchFrom", choose: true }] },
];

type Popup = { group: Group } & ({ kind: "menu"; x: number; y: number } |
  { kind: "confirm"; option: Option; remote: string });

export function GitSync({ info, disabled, busy, onRun, t }: {
  info: SyncInfo; disabled: boolean; busy: boolean; onRun: (request: SyncRequest) => void; t: T;
}) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const shown = disabled ? null : popup;
  const confirming = shown?.kind === "confirm";

  useLayoutEffect(() => { if (disabled) setPopup(null); }, [disabled]);
  useLayoutEffect(() => {
    if (!confirming || !confirmation.current || !trigger.current) return;
    const panel = confirmation.current;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - panel.offsetHeight - 8))}px`;
    };
    place();
    panel.querySelector<HTMLElement>("select:not(:disabled), button")?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPopup(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPopup(null);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", place);
    };
  }, [confirming]);

  const close = () => { setPopup(null); trigger.current?.focus(); };
  const run = (option: Option, remote: string) => {
    if (disabled) return;
    close();
    onRun({ action: option.action, ...(info.branch ? { branch: info.branch } : {}),
      ...(option.choose ? { remote } : {}), ...(option.action === "forcePush" ? { leaseToken: info.forceLease?.token } : {}) });
  };
  const pick = (group: Group, option: Option) => {
    const preferred = option.action === "forcePush" ? info.forceLease?.remote : option.action === "push" ? info.pushRemote : info.defaultRemote;
    const remote = preferred ?? (option.choose ? info.remotes[0] : undefined) ?? "";
    if (option.action === "fetch" && remote && !option.choose) run(option, remote);
    else setPopup({ kind: "confirm", group, option, remote });
  };
  const canPick = (option: Option) => {
    if (disabled || !info.remotes.length) return false;
    if (option.action === "fetch") return option.choose || !!info.defaultRemote;
    if (!info.branch || info.hasHead === false) return false;
    if (option.action === "pull" || option.action === "pullRebase") return !!info.upstream;
    if (option.action === "forcePush") return !!info.forceLease;
    return option.choose || !!info.pushRemote;
  };
  const menuGroup = shown?.kind === "menu" ? groups.find(group => group.id === shown.group) : null;

  return <div className="scm-inline-sync" role="group" aria-label={t("gitRemoteActions")} aria-busy={busy}>
    {groups.map(group => {
      const open = shown?.group === group.id;
      const count = group.id === "pull" ? info.behind : group.id === "push" && info.pushRemote && info.upstream?.startsWith(`${info.pushRemote}/`) ? info.ahead : undefined;
      return <button key={group.id} type="button" className="scm-sync-btn" disabled={disabled} data-sync={group.id}
        aria-haspopup="menu" aria-expanded={open} aria-label={t(group.label)} title={t(group.label)}
        onClick={event => {
          if (open && confirming) { close(); return; }
          trigger.current = event.currentTarget;
          const rect = event.currentTarget.getBoundingClientRect();
          setPopup({ kind: "menu", group: group.id, x: rect.left, y: rect.bottom + 4 });
        }}>
        <GitIcon name={group.id} size={13} /><span className="scm-sync-label">{t(group.label)}</span>
        {count != null && count > 0 && <span className="scm-sync-count">{count > 999 ? "999+" : count}</span>}
      </button>;
    })}
    {shown?.kind === "menu" && menuGroup && <ContextMenu key={menuGroup.id} x={shown.x} y={shown.y}
      onClose={reason => { setPopup(null); if (reason === "escape") trigger.current?.focus(); }}
      entries={[
        ...(!info.remotes.length ? [{ kind: "item" as const, label: t("noRemote"), disabled: true, onPick: () => {} }] : []),
        ...menuGroup.options.map(option => ({ kind: "item" as const, label: t(option.label),
          danger: option.action === "forcePush", disabled: !canPick(option), onPick: () => pick(menuGroup.id, option),
          icon: <GitIcon name={groupIcon(option.action)} /> })),
      ]} />}
    {shown?.kind === "confirm" && <div ref={confirmation} className="scm-popover scm-confirm" role="dialog" aria-label={t(shown.option.label)}>
      <strong>{t(shown.option.label)}</strong>
      {info.branch && <small>{t("statusBranch")}: {info.branch}</small>}
      {shown.option.choose ? <label>{t("gitRemote")}
        <select value={shown.remote} onChange={e => setPopup({ ...shown, remote: e.target.value })}>
          {info.remotes.map(remote => <option key={remote}>{remote}</option>)}
        </select>
      </label> : <small>{t("gitRemote")}: {shown.remote}</small>}
      {shown.option.action === "forcePush" && info.forceLease && <>
        <p>{t("gitForceWarning")}</p>
        <code>{info.forceLease.remote}/{info.forceLease.branch} @ {info.forceLease.expectedOid.slice(0, 12)}</code>
      </>}
      <div>
        <button type="button" onClick={close}>{t("cancel")}</button>
        <button type="button" className={shown.option.action === "forcePush" ? "danger" : ""}
          disabled={!shown.remote || !canPick(shown.option)} onClick={() => run(shown.option, shown.remote)}>{t("confirm")}</button>
      </div>
    </div>}
  </div>;
}

function groupIcon(action: SyncAction) {
  return action === "pullRebase" ? "pull" : action;
}
