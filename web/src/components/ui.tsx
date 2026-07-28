import React from 'react';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function whenNext(iso: string | null | undefined): string {
  if (!iso) return 'when due';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return 'due now';
  const hr = Math.round(ms / 3_600_000);
  if (hr < 24) return `in ${Math.max(1, hr)}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export const money = (n: number) => `$${n.toFixed(2)}`;

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  children: React.ReactNode;
}) {
  return <span className={`badge ${tone === 'neutral' ? '' : tone}`}>{children}</span>;
}

const STATUS_TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  active: 'ok',
  ok: 'ok',
  tracked: 'accent',
  discovered: 'warn',
  candidate: 'warn',
  paused: 'neutral',
  archived: 'neutral',
  dead: 'danger',
  rejected: 'danger',
  error: 'danger',
  budget_stopped: 'warn',
  running: 'accent',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={wide ? { maxWidth: 960 } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inline" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div className="spacer" />
          <button className="small" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}

/**
 * A labelled form control. Generates the id and wires label→control so clicking
 * the label focuses the field and screen readers announce it. Use this rather
 * than a bare <label> + <input> pair, which associates neither.
 */
export function Field({
  label,
  hint,
  className = 'field',
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className={className}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="banner danger">{error}</div>;
}
