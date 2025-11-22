'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { supabase } from '@/lib/supabase';

/** ===== Config & helpers ===== */
const BUCKET_MIN = 15;
const mins = (n: number) => n * 60 * 1000;
const hours = (n: number) => n * 60 * 60 * 1000;

const roundUpToBucket = (d: Date, bucketMin = BUCKET_MIN) => {
  const ms = d.getTime();
  const bucket = bucketMin * 60 * 1000;
  return new Date(Math.ceil(ms / bucket) * bucket);
};

const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);

const largestPrimeFactor = (n: number) => {
  let x = n;
  let lpf = 1;
  while (x % 2 === 0) {
    lpf = 2;
    x /= 2;
  }
  for (let f = 3; f * f <= x; f += 2) {
    while (x % f === 0) {
      lpf = f;
      x /= f;
    }
  }
  if (x > 1) lpf = x;
  return lpf;
};

// --- Minimal catalog ---
const CATALOG = {
  costco: {
    label: 'Costco',
    items: [
      { key: 'tp30', label: 'Toilet paper (30)', total: 30 },
      { key: 'pt12', label: 'Paper towels (12)', total: 12 },
    ],
  },
} as const;

type Direction = 'north' | 'south' | 'east' | 'west';

type Signal = {
  id: string;
  direction: Direction;
  purpose: string;
  window_start: string;
  window_end: string;
  units_total: number;
  units_claimed: number;
  expires_at: string;
  // feedback/notes are not required in table, but we support them if present
  feedback?: string | null;
  feedback_notes?: string | null;
};

const Card = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: 12, background: '#2C2C2C', borderRadius: 8 }}>
    {children}
  </div>
);

export default function Home() {
  /** ----- State ----- */
  const [signals, setSignals] = useState<Signal[]>([]);
  const [role, setRole] = useState<'operator' | 'requester'>('operator');

  const [form, setForm] = useState({
    direction: 'north' as Direction,
    storeKey: 'costco',
    itemKey: 'tp30',
    leaveInMin: 0,
    windowHours: 2,
    units: 6,
    payments: [] as string[],
  });

  // Feedback textarea refs per signal
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});

  const nowRounded = roundUpToBucket(new Date(), BUCKET_MIN);

  /** ----- Derived values ----- */
  const store = CATALOG[form.storeKey as keyof typeof CATALOG];
  const item = store.items.find((i) => i.key === form.itemKey)!;
  const unitsAuto = useMemo(
    () => largestPrimeFactor(item.total),
    [item.total]
  );
  const unitSize = useMemo(
    () => item.total / unitsAuto,
    [item.total, unitsAuto]
  );
  const purposeText = `${store.label} • ${
    item.label.split(' (')[0]
  }`; // e.g. "Costco • Toilet paper"

  useEffect(() => {
    setForm((f) => ({ ...f, units: unitsAuto }));
  }, [unitsAuto, form.itemKey]);

  /** ----- Load + live updates ----- */
  const load = async () => {
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .order('window_start', { ascending: true });

    if (!error) {
      setSignals(
        (data ?? []).map((s: any) => ({
          ...s,
          units_claimed: Number.isFinite(+s.units_claimed)
            ? +s.units_claimed
            : 0,
          units_total: Number.isFinite(+s.units_total) ? +s.units_total : 0,
        }))
      );
    } else {
      console.error('Load signals error:', error.message);
    }
  };

  useEffect(() => {
    (async () => {
      await load();
    })();

    const ch = supabase
      .channel('signals-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'signals' },
        () => {
          load();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  /** ----- Post a new signal ----- */
  const postSignal = async (e: React.FormEvent) => {
    e.preventDefault();

    const start = new Date(nowRounded.getTime() + mins(form.leaveInMin));
    const end = new Date(start.getTime() + hours(form.windowHours));

    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const expiresIso = new Date(end.getTime() + hours(2)).toISOString();

    const units_total = Math.max(1, Math.min(24, Number(form.units) || 1));

    const { error } = await supabase.from('signals').insert({
      direction: form.direction,
      purpose: purposeText,
      window_start: startIso,
      window_end: endIso,
      units_total,
      expires_at: expiresIso,
      // store payment methods as a JSON-ish array; adjust schema if you want strict typing
    });

    if (error) {
      console.error(error);
      alert('Insert failed: ' + error.message);
    } else {
      await load();
    }
  };

  /** ----- Claim a unit ----- */
  const claimOne = async (s: Signal) => {
    const expired = dayjs().isAfter(dayjs(s.expires_at));
    if (s.units_claimed >= s.units_total || expired) return;

    const { error: insertError } = await supabase
      .from('claims')
      .insert({ signal_id: s.id, unit_count: 1 });

    if (insertError) {
      console.error(insertError);
      alert('Claim failed: ' + insertError.message);
      return;
    }

    const { error: rpcError } = await supabase.rpc('increment_claimed', {
      p_signal_id: s.id,
      p_count: 1,
    });

    if (rpcError) {
      console.error(rpcError);
      alert('Claim failed: ' + rpcError.message);
      return;
    }

    await load();
  };

  /** ----- Feedback ----- */
  const submitFeedback = async (signalId: string, fb: 'ok' | 'not_ok') => {
    try {
      setSubmitting((p) => ({ ...p, [signalId]: true }));
      const notes = noteRefs.current[signalId]?.value?.trim() || null;

      const { error } = await supabase.from('feedback').insert({
        signal_id: signalId,
        feedback: fb,
        notes,
      });

      if (error) {
        console.error(error);
        alert('Feedback failed: ' + error.message);
        return;
      }

      await load();
      alert('Thanks — feedback saved.');
    } finally {
      setSubmitting((p) => ({ ...p, [signalId]: false }));
    }
  };

  /** ----- Filter active signals (hide expired) ----- */
  const now = dayjs();
  const activeSignals = signals.filter((s) =>
    now.isBefore(dayjs(s.expires_at))
  );

    // --- JSX layout ---
  return (
    <main
      style={{
        maxWidth: 640,
        margin: '40px auto',
        padding: 16,
        color: '#E0E0E0',
        background: '#202020',
        borderRadius: 12,
        fontSize: 16,
      }}
    >
      {/* App header */}
      <h1 style={{ marginBottom: 4 }}>within • Shared Runs Pilot</h1>

      <div
        style={{
          opacity: 0.6,
          marginBottom: 8,
          fontSize: 13,
          textAlign: 'left',
        }}
      >
        No logins. No stored personal data. Trust.
      </div>

      {/* Pilot feedback banner */}
      <div
        style={{
          background: '#F5D76E',
          color: '#2C2C2C',
          padding: '10px 14px',
          borderRadius: 8,
          marginBottom: 16,
          fontSize: 14,
          lineHeight: 1.4,
        }}
      >
        <strong>Pilot Feedback (important)</strong>
        <br />
        Please send any feedback directly by text during this phase.
      </div>

      {/* Role toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setRole('operator')}
          style={{
            flex: 1,
            background: role === 'operator' ? '#444' : '#2c2c2c',
            color: '#fff',
            padding: '8px',
            borderRadius: '6px',
          }}
        >
          Operator
        </button>
        <button
          onClick={() => setRole('requester')}
          style={{
            flex: 1,
            background: role === 'requester' ? '#444' : '#2c2c2c',
            color: '#fff',
            padding: '8px',
            borderRadius: '6px',
          }}
        >
          Requester
        </button>
      </div>

      {/* Operator form */}
      {role === 'operator' && (
        <Card>
          <form onSubmit={postSignal} style={{ display: 'grid', gap: 10 }}>
            <label>
              Direction
              <select
                value={form.direction}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    direction: e.target.value as Direction,
                  }))
                }
              >
                <option>north</option>
                <option>south</option>
                <option>east</option>
                <option>west</option>
              </select>
            </label>

            <div
              style={{
                display: 'grid',
                gap: 10,
                gridTemplateColumns: '1fr 1fr',
              }}
            >
              <label>
                Store
                <select
                  value={form.storeKey}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      storeKey: e.target.value,
                      itemKey: CATALOG.costco.items[0].key,
                    }))
                  }
                >
                  <option value="costco">Costco</option>
                </select>
              </label>

              <label>
                Item
                <select
                  value={form.itemKey}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, itemKey: e.target.value }))
                  }
                >
                  {store.items.map((i) => (
                    <option key={i.key} value={i.key}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div
              style={{
                display: 'grid',
                gap: 10,
                gridTemplateColumns: '1fr 1fr',
              }}
            >
              <label>
                Leave in
                <select
                  value={form.leaveInMin}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      leaveInMin: Number(e.target.value),
                    }))
                  }
                >
                  <option value={0}>Now</option>
                  <option value={15}>+15 min</option>
                  <option value={30}>+30 min</option>
                  <option value={45}>+45 min</option>
                  <option value={60}>+60 min</option>
                </select>
              </label>

              <label>
                Window
                <select
                  value={form.windowHours}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      windowHours: Number(e.target.value),
                    }))
                  }
                >
                  <option value={1}>1 hour</option>
                  <option value={2}>2 hours</option>
                </select>
              </label>
            </div>

            <label>
              Units available
              <input
                type="number"
                value={form.units}
                readOnly
                style={{ background: '#3A3A3A', color: '#E0E0E0' }}
              />
            </label>

            <div
              style={{ fontSize: 12, opacity: 0.8, marginTop: -6 }}
            >{`${item.total} total → ${form.units} units • ${unitSize} each`}</div>

            <label>
              Payment methods
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {['Venmo', 'Cash App', 'Zelle'].map((method) => (
                  <label key={method} style={{ fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={form.payments.includes(method)}
                      onChange={(e) => {
                        const selected = form.payments;
                        setForm((f) => ({
                          ...f,
                          payments: e.target.checked
                            ? [...selected, method]
                            : selected.filter((m) => m !== method),
                        }));
                      }}
                    />
                    {method}
                  </label>
                ))}
              </div>
            </label>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Note: on some store runs I receive ~2% card cashback. No extra fee is added for you;
              this helps keep the pilot operational.
            </div>


        
            <button type="submit">Go (post shared run)</button>

            {/* Optional: show computed times for operator */}
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Start ~{' '}
              {toLocalInput(
                new Date(nowRounded.getTime() + mins(form.leaveInMin))
              )}{' '}
              | End ~{' '}
              {toLocalInput(
                new Date(
                  nowRounded.getTime() +
                    mins(form.leaveInMin) +
                    hours(form.windowHours)
                )
              )}
            </div>
          </form>
        </Card>
      )}

      {/* Requester list */}
      {role === 'requester' && (
        <>
          <h2 style={{ marginTop: 16 }}>Active Signals</h2>

          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 8,
            }}
          >
            {activeSignals.map((s) => (
              <li key={s.id}>
                <Card>
                  {/* top row */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <b>{s.purpose}</b> • {s.direction.toUpperCase()}
                    </div>
                    <div style={{ opacity: 0.8 }}>
                      {dayjs(s.window_start).format('h:mm a')}–
                      {dayjs(s.window_end).format('h:mm a')}
                    </div>
                  </div>

                  {/* units */}
                  <div style={{ marginTop: 6 }}>
                    Units: {s.units_claimed}/{s.units_total}
                  </div>

                  {/* claim button */}
                  <button
                    style={{ marginTop: 8 }}
                    disabled={
                      s.units_claimed >= s.units_total ||
                      dayjs().isAfter(dayjs(s.expires_at))
                    }
                    onClick={() => claimOne(s)}
                  >
                    {s.units_claimed >= s.units_total
                      ? 'Full'
                      : 'Claim 1 unit'}
                  </button>

              {/* Feedback routed outside app for pilot */}
              <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
                Please send any feedback directly by text during this phase.
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}