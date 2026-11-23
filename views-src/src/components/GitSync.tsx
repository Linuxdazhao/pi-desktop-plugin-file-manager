import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import type { Failure } from '../lib/rpc';
import { IconButton } from './IconButton';

export type RepoContext = { workspacePath: string; rootPath: string; projectId?: string };
export type SyncInfo = { ok: true; state: 'missing' | 'plain' | 'repository'; branch: string; remotes: string[]; upstream?: string; defaultRemote?: string; pushRemote?: string; forceLease?: { remote: string; branch: string; expectedOid: string; token: string } };
type Action = 'fetch' | 'pull' | 'pullRebase' | 'push' | 'forcePush';
const options: { action: Action; en: string; zh: string; choose?: boolean }[] = [
  { action: 'fetch', en: 'Fetch', zh: '获取' }, { action: 'fetch', en: 'Fetch From…', zh: '从指定远端获取…', choose: true },
  { action: 'pull', en: 'Pull', zh: '拉取' }, { action: 'pullRebase', en: 'Pull (Rebase)', zh: '拉取（变基）' },
  { action: 'push', en: 'Push', zh: '推送' }, { action: 'push', en: 'Push To…', zh: '推送到…', choose: true },
  { action: 'forcePush', en: 'Force Push (with lease)…', zh: '强制推送（带租约）…' },
];
export function GitSync({ context, info, zh, disabled, onBusy, onDone, onError }: {
  context: RepoContext; info: SyncInfo; zh: boolean; disabled: boolean; onBusy: (value: boolean) => void; onDone: () => void; onError: (msg: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [option, setOption] = useState<typeof options[number] | null>(null);
  const [remote, setRemote] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!menu && !option) return;
    const close = () => { setMenu(false); setOption(null); };
    const outside = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); box.current?.querySelector<HTMLButtonElement>('.scm-sync-trigger')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [menu, option]);
  const name = (op: typeof options[number]) => zh ? op.zh : op.en;
  async function run(op: typeof options[number], target: string) {
    setMenu(false); setOption(null); onError(''); onBusy(true);
    try {
      const response = await invoke<{ok: true} | Failure>('fm.git.syncAction', { ...context, action: op.action, ...(info.branch && { branch: info.branch }),
        ...(op.choose && { remote: target }), confirm: true, ...(op.action === 'forcePush' && { leaseToken: info.forceLease?.token }) });
      if (!response.ok) throw Error(response.message);
      if (alive.current) onDone();
    } catch (e) { if (alive.current) onError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) onBusy(false); }
  }
  function pick(op: typeof options[number]) {
    const preferred = op.action === 'forcePush' ? info.forceLease?.remote : op.action === 'push' ? info.pushRemote : info.defaultRemote;
    const target = preferred ?? (op.choose ? info.remotes[0] : undefined);
    setRemote(target ?? ''); setMenu(false);
    if (op.action === 'fetch' && !op.choose && target) void run(op, target); else setOption(op);
  }
  const label = zh ? '远程同步操作' : 'Remote actions';
  return <div className="scm-sync" ref={box}>
    <IconButton className="scm-sync-trigger" small label={label} active={menu || !!option} disabled={disabled} onClick={() => { setOption(null); setMenu(!menu); }}>
      <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4 4-4-4 4-4" />
    </IconButton>
    {menu && <div className="scm-popover" role="group" aria-label={label}>
      {!info.remotes.length && <p>{zh ? '尚未配置远端。请先在 Git 中添加远端。' : 'No remote configured. Add a remote in Git first.'}</p>}
      {options.map(op => <button key={op.en} type="button" disabled={!info.remotes.length} className={op.action === 'forcePush' ? 'danger' : ''} onClick={() => pick(op)}>{name(op)}</button>)}
    </div>}
    {option && <div className="scm-popover scm-confirm" role="group" aria-label={name(option)}>
      <strong>{name(option)}</strong><small>{zh ? '当前分支：' : 'Branch: '}{info.branch}</small>
      <label>{zh ? '远端' : 'Remote'}<select value={remote} disabled={!option.choose} onChange={e => setRemote(e.target.value)}>{!remote && <option value="">{zh ? '未指定默认目标' : 'No default target'}</option>}{info.remotes.map(r => <option key={r}>{r}</option>)}</select></label>
      {!remote && option.action !== 'forcePush' && <small>{zh ? '请使用指定远端的操作，或先配置上游。' : 'Choose a named remote action or configure the upstream first.'}</small>}
      {option.action === 'forcePush' && <p>{zh ? '将改写远端分支历史。远端与已获取的版本不一致时会拒绝。' : 'Rewrites remote branch history. Refused if the remote no longer matches the fetched revision.'}</p>}
      {option.action === 'forcePush' && <small>{info.forceLease ? `${info.forceLease.remote}/${info.forceLease.branch} @ ${info.forceLease.expectedOid.slice(0,12)}` : zh ? '请先获取默认推送目标并刷新以取得租约。' : 'Fetch the default push target and refresh to obtain a lease.'}</small>}
      <div><button type="button" onClick={() => setOption(null)}>{zh ? '取消' : 'Cancel'}</button><button type="button" className={option.action === 'forcePush' ? 'danger' : ''} disabled={!remote} onClick={() => void run(option, remote)}>{zh ? '确认执行' : 'Confirm'}</button></div>
    </div>}
  </div>;
}
