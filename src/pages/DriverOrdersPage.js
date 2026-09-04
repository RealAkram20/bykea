import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { jobPath } from '../components/driver/useDriverJob';
import { formatGBP } from '../lib/currency';
import {
  fetchActiveOrdersForDriver,
  fetchCompletedDeliveriesForDriver,
  formatOfferTime,
} from '../lib/driverIncomingBookings';
import { getDriverSession } from '../lib/driverSession';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';
import './driverPortal.css';
import './driverOrdersPremium.css';

const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'history', label: 'History' },
];

function statusClass(st) {
  if (st === 'Delivered') return 'dplOrdSt dplOrdSt--dn';
  if (st === 'Cancelled') return 'dplOrdSt dplOrdSt--cx';
  return 'dplOrdSt dplOrdSt--pickup';
}

function lineStatusClass(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('drop') || s.includes('delivering') || s.includes('transit')) {
    return 'dplOrdSt dplOrdSt--enroute';
  }
  if (s.includes('pickup') || s.includes('heading')) return 'dplOrdSt dplOrdSt--pickup';
  return 'dplOrdSt dplOrdSt--pickup';
}

function historyStatusLabel(kind) {
  if (kind === 'shop') return 'Delivered';
  if (kind === 'taxi' || kind === 'tuktuk') return 'Completed';
  return 'Delivered';
}

export default function DriverOrdersPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('active');
  const [active, setActive] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const driverId = getDriverSession()?.id || null;

  const load = useCallback(async () => {
    setLoadErr('');
    if (!driverId || !isSupabaseConfigured || !supabase) {
      setActive([]);
      setHistory([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [act, hist] = await Promise.all([
        fetchActiveOrdersForDriver(supabase, driverId),
        fetchCompletedDeliveriesForDriver(supabase, driverId),
      ]);
      setActive(act);
      setHistory(hist);
    } catch (e) {
      setActive([]);
      setHistory([]);
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    load();
  }, [load]);

  const openActive = (row) => {
    navigate(jobPath('active-delivery', row.order), { state: { order: row.order } });
  };

  return (
    <div className="dpl dpl--premium" role="main" aria-label="Orders">
      <header className="dpl__hero">
        <h1 className="dplH dpl__title">Orders</h1>
        <p className="dplIntro dpl__subtitle">Active jobs and your recent delivery history.</p>
      </header>

      <div className="dpl__tabsWrap">
        <div className="dplTabs" role="tablist" aria-label="Order lists">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'dplTab dplTab--on' : 'dplTab'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="dplBody">
        {loadErr ? (
          <p className="dpl__empty dpl__empty--err" role="alert">
            {loadErr}
          </p>
        ) : null}

        {tab === 'active' && (
          <>
            {loading ? (
              <p className="dpl__empty">Loading active deliveries…</p>
            ) : active.length === 0 ? (
              <p className="dpl__empty">No active deliveries. Go online on Home to receive offers.</p>
            ) : (
              active.map((row) => (
                <div key={row.order?.supabaseOrderId || row.id} className="dplOrdCard dplOrdCard--act">
                  <div className="dplOrdTop">
                    <p className="dplOrdId">{row.id}</p>
                    <span className={lineStatusClass(row.lineStatus)}>{row.lineStatus}</span>
                  </div>

                  <div className="dplRoute">
                    <div className="dplRoute__row dplRoute__row--pick">
                      <span className="dplRoute__dot" aria-hidden />
                      <p className="dplRoute__addr">{row.from}</p>
                    </div>
                    <div className="dplRoute__row dplRoute__row--drop">
                      <span className="dplRoute__dot" aria-hidden />
                      <p className="dplRoute__addr">{row.to}</p>
                    </div>
                  </div>

                  <p className="dplOrdMeta">
                    {row.pkg}
                    {' · '}
                    {row.lineTime}
                  </p>

                  <div className="dplOrdPayout">
                    <span className="dplOrdPayoutLbl">Payout</span>
                    <span className="dplOrdPayoutAmt">{formatGBP(row.amount)}</span>
                  </div>

                  <button type="button" className="dplOrdGo" onClick={() => openActive(row)}>
                    Continue Delivery
                  </button>
                </div>
              ))
            )}
          </>
        )}

        {tab === 'history' && (
          <>
            {loading ? (
              <p className="dpl__empty">Loading history…</p>
            ) : history.length === 0 ? (
              <p className="dpl__empty">No completed deliveries yet.</p>
            ) : (
              history.map((r) => {
                const st = historyStatusLabel(r.kind);
                return (
                  <div key={`${r.kind}-${r.id}`} className="dplOrdCard dplOrdCard--hist">
                    <div className="dplOrdTop">
                      <p className="dplOrdId">{r.ref}</p>
                      <span className={statusClass(st)}>{st}</span>
                    </div>
                    <p className="dplOrdHistTo">{r.to}</p>
                    <div className="dplOrdPayout">
                      <span className="dplOrdPayoutLbl">{formatOfferTime(r.at)}</span>
                      <span className="dplOrdPayoutAmt">{formatGBP(r.amount)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
