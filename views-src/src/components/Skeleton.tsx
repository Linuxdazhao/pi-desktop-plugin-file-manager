import { memo } from 'react';

type Kind = 'list' | 'lines' | 'diff' | 'table' | 'page';
const widths = [68, 43, 79, 56, 35, 71, 48, 61];

/** Fixed row budget, one animated group; no clocks, measurements or per-row layers. */
export const Skeleton = memo(function Skeleton({ kind, label, compact = false }: { kind: Kind; label: string; compact?: boolean }) {
  const count = compact ? (kind === 'list' ? 2 : 3) : kind === 'list' ? 5 : kind === 'table' ? 5 : 8;
  return <div className="fm-skeleton" data-skeleton={kind} data-compact={compact || undefined} role="status" aria-label={label}>
    <div aria-hidden="true" className="fm-skeleton-body">
      {Array.from({ length: count }, (_, i) => <div key={i} className="fm-skeleton-row">
        {kind !== 'page' && <i className="fm-skeleton-gutter" />}
        <i className="fm-skeleton-stroke" style={{ width: `${widths[i]}%` }} />
        {kind === 'table' && <><i className="fm-skeleton-stroke" /><i className="fm-skeleton-stroke" /></>}
      </div>)}
    </div>
  </div>;
});
