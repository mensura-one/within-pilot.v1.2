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

type Direction = 'north' | 'south' | 'east' | 'west';

type Signal = {
  id: string;
  direction: Direction;
  purpose: string;
  window_start: string;
  window_end: string;
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
  const [mounted, setMounted] = useState(false);
  const [isOperatorMode, setIsOperatorMode] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [role, setRole] = useState<'operator' | 'requester'>('requester');

  const [form, setForm] = useState({
  direction: 'north' as Direction,
  destination: '',
  itemText: '',
  leaveInMin: 0,
  windowHours: 2,
});

useEffect(() => {
  setMounted(true);

  const params = new URLSearchParams(window.location.search);
  setIsOperatorMode(params.get('operator') === '1');
}, []);


    
  // Feedback textarea refs per signal
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});

  const nowRounded = roundUpToBucket(new Date(), BUCKET_MIN);

  /** ----- Load + live updates ----- */
const load = async () => {
  const res = await supabase
    .from('signals')
    .select('*')
    .order('window_start', { ascending: true });

  if (res.error) {
    console.error('load() error:', res.error);
    return;
  }

  setSignals((res.data || []) as Signal[]);
};

useEffect(() => {
  load();

  const ch = supabase
    .channel('signals-live')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'signals' },
      load
    )
    .subscribe();

  return () => {
    supabase.removeChannel(ch);
  };
}, []);

  const purposeText = [form.destination.trim(), form.itemText.trim()]
  .filter(Boolean)
  .join(' • ');

  /** ----- Post a new signal ----- */
  /** ----- Post a new signal ----- */
const postSignal = async (e: React.FormEvent) => {
  e.preventDefault();

  const start = new Date(nowRounded.getTime() + mins(form.leaveInMin));
  const end = new Date(start.getTime() + hours(form.windowHours));

  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const expiresIso = new Date(end.getTime() + hours(2)).toISOString();

  const res = await supabase.from('signals').insert({
    direction: form.direction,
    purpose: purposeText,
    window_start: startIso,
    window_end: endIso,
    expires_at: expiresIso,
  });

  if (res.error) {
    console.error('postSignal() error:', res.error);
    alert('Insert failed — see console (postSignal() res)');
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
{mounted && isOperatorMode && (
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
)}

{/* Operator form */}
{mounted && isOperatorMode && role === 'operator' && (
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
          Where I’m heading (optional)
          <input
            value={form.destination}
            onChange={(e) =>
              setForm((f) => ({ ...f, destination: e.target.value }))
            }
            placeholder="e.g., Costco Georgetown"
          />
        </label>

        <label>
          One item
          <input
            value={form.itemText}
            onChange={(e) =>
              setForm((f) => ({ ...f, itemText: e.target.value }))
            }
            placeholder="e.g., paper towels"
            required
          />
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

      <button type="submit">Go (post shared run)</button>

      <div style={{ fontSize: 12, opacity: 0.8 }}>
        Start ~{' '}
        {toLocalInput(new Date(nowRounded.getTime() + mins(form.leaveInMin)))} | End ~{' '}
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

              {/* Feedback routed outside app for pilot */}
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
  Text the operator to coordinate.
</div>

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