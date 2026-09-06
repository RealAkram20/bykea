import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useShopCart } from '../context/ShopCartContext';
import { buildLiveTrackingState } from '../lib/liveTrackingState';
import { writeShopOrderConfirmationState } from '../lib/shopOrderConfirmationSession';
import {
  stripeEdgeFinalizeCheckoutSession,
  takeStripeHostedReturnContext,
} from '../lib/stripeEdge';
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { notifyDriversOfNewOffer } from '../lib/driverOfferPushNotify';

/** The booking table the sender rings for each Stripe order kind; shop orders ring when the shop marks them ready. */
const RING_TABLE_BY_KIND = {
  delivery: 'customer_delivery_orders',
  taxi: 'taxi_bookings',
  tuk: 'tuk_tuk_bookings',
};

export default function StripeReturnPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { clearCart } = useShopCart();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sessionId = searchParams.get('session_id');
      if (!sessionId) {
        setErr('Missing payment session. Return home and try again if you were charged.');
        setBusy(false);
        return;
      }
      if (!isSupabaseConfigured) {
        setErr('Supabase is not configured.');
        setBusy(false);
        return;
      }

      const fin = await stripeEdgeFinalizeCheckoutSession({ sessionId });
      if (cancelled) return;
      if (!fin.ok) {
        setErr(fin.error || 'Could not confirm payment.');
        setBusy(false);
        return;
      }

      // A card-paid delivery or ride never rang a driver: the booking pages ring
      // only for cash and wallet, and nothing rang once the card cleared (found
      // 2026-09-06). From here the order is `paid`, the status the sender
      // accepts. Skipped on a reload of an already-paid session.
      const ringTable = RING_TABLE_BY_KIND[String(fin.orderKind || '')];
      if (ringTable && fin.orderId && !fin.alreadyPaid) {
        notifyDriversOfNewOffer(ringTable, String(fin.orderId));
      }

      const ctx = takeStripeHostedReturnContext();

      if (ctx?.flow === 'order_confirmation' && ctx.state) {
        if (ctx.state?.source === 'shop') {
          try {
            clearCart();
          } catch {
            // ignore
          }
          writeShopOrderConfirmationState(ctx.state);
          navigate('/order-confirmation', { replace: true, state: ctx.state });
          return;
        }
        const ltState = buildLiveTrackingState(ctx.state);
        if (ltState) {
          writeShopOrderConfirmationState(ctx.state);
          navigate('/live-tracking', { replace: true, state: ltState });
          return;
        }
        writeShopOrderConfirmationState(ctx.state);
        navigate('/order-confirmation', { replace: true, state: ctx.state });
        return;
      }

      if (ctx?.flow === 'live_tracking' && ctx.state) {
        if (ctx.rideOrderConfirmation && typeof ctx.rideOrderConfirmation === 'object') {
          try {
            writeShopOrderConfirmationState(ctx.rideOrderConfirmation);
          } catch {
            // ignore
          }
        }
        navigate('/live-tracking', { replace: true, state: ctx.state });
        return;
      }

      if (ctx?.flow === 'driver_wallet') {
        navigate('/driver/wallet', { replace: true });
        return;
      }

      if (ctx?.flow === 'customer_wallet') {
        navigate('/wallet', {
          replace: true,
          state: { walletTopupPaid: true, walletTopupId: ctx.topupId || null },
        });
        return;
      }

      navigate('/', { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, navigate, clearCart]);

  return (
    <div style={{ padding: '1.25rem', maxWidth: 520, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      {busy ? <p style={{ margin: 0 }}>Confirming payment…</p> : null}
      {err ? (
        <>
          <p role="alert" style={{ color: '#b42318', marginTop: '0.5rem' }}>
            {err}
          </p>
          <p style={{ marginTop: '0.75rem' }}>
            <Link to="/">Home</Link>
          </p>
        </>
      ) : null}
    </div>
  );
}
