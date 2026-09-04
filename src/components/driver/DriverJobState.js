/**
 * What a chain screen shows when it has no job to show.
 *
 * One component, so "this job is gone" reads the same on every step instead of
 * six screens each inventing their own answer — or, as before, quietly rendering
 * the demo fixture as though it were a real delivery.
 */
import { useNavigate } from 'react-router-dom';

/**
 * @param {{ status: 'loading' | 'missing' | 'error', error?: string, label?: string, onRetry?: () => void }} props
 */
export default function DriverJobState({ status, error = '', label = 'delivery', onRetry }) {
  const navigate = useNavigate();

  const title =
    status === 'loading'
      ? `Loading your ${label}…`
      : status === 'error'
        ? `Could not load your ${label}`
        : 'That job is no longer open';

  const body =
    status === 'loading'
      ? 'Fetching it from your active jobs.'
      : status === 'error'
        ? error || 'Check your connection and try again.'
        : 'It may be finished or cancelled, or another driver may have it now. Your active jobs are on the Orders tab.';

  return (
    <div
      className="dh dh--premium"
      role="main"
      aria-label={title}
      style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem' }}
    >
      <div style={{ maxWidth: '22rem', textAlign: 'center' }} role="status" aria-live="polite">
        <h1 style={{ font: '600 1.15rem/1.3 system-ui, sans-serif', margin: '0 0 0.5rem', color: '#111827' }}>
          {title}
        </h1>
        <p style={{ font: '400 0.9rem/1.5 system-ui, sans-serif', margin: '0 0 1.25rem', color: '#6b7280' }}>{body}</p>

        {status === 'loading' ? null : (
          <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            {status === 'error' && onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                style={{
                  font: '600 0.9rem system-ui, sans-serif',
                  padding: '0.7rem 1.15rem',
                  borderRadius: '0.6rem',
                  border: '1px solid #d1d5db',
                  background: '#fff',
                  color: '#111827',
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => navigate('/driver/orders', { replace: true })}
              style={{
                font: '600 0.9rem system-ui, sans-serif',
                padding: '0.7rem 1.15rem',
                borderRadius: '0.6rem',
                border: 'none',
                background: '#EC6C23',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Go to Orders
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
