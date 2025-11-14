'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
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
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const largestPrimeFactor = (n: number) => {
  let x = n, lpf = 1;
  while (x % 2 === 0) { lpf = 2; x /= 2; }
  for (let f = 3; f * f <= x; f += 2) {
    while (x % f === 0) { lpf = f; x /= f; }
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
};

export default function Home() {
  const [notesBySignal, setNotesBySignal] = useState<Record<string, string>>({});
  const [submitting,   setSubmitting]   = useState<Record<string, boolean>>({});

  // Track feedback notes per active signal
  const [feedbackNotesMap, setFeedbackNotesMap] = useState<{ [key: string]: string }>({});

  // --- All state hooks ---
  // state you already have…
const [signals, setSignals] = useState<Signal[]>([]);

const [form, setForm] = useState({
  direction: 'north' as Direction,
  storeKey: 'costco',
  itemKey: 'tp30',
  leaveInMin: 0,
  windowHours: 2,
  units: 6,
}); // <- closes the object and the useState. Nothing after this line.

const togglePref = (key: string) => {
  setPaymentPrefs(prev => {
    const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
    if (typeof window !== 'undefined') {
      localStorage.setItem('payment_prefs', JSON.stringify(next));
    }
    return next;
  });
};

const [role, setRole] = useState<'operator' | 'requester'>('operator');

// 👇 add this line
 const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

 const nowRounded = roundUpToBucket(new Date(), BUCKET_MIN);
 
// Local memory for last-used payment preference
const [paymentPrefs, setPaymentPrefs] = useState<string[]>(() => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem('payment_prefs');
    if (!raw) return [];                     // nothing saved yet
    const parsed = JSON.parse(raw);          // may throw
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // if bad data was saved (e.g., "undefined"), reset
    return [];
  }
});

useEffect(() => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('payment_prefs', JSON.stringify(paymentPrefs));
  }
}, [paymentPrefs]);

  // --- Derived values ---
  const store = CATALOG[form.storeKey];
  const item = store.items.find(i => i.key === form.itemKey)!;
  const unitsAuto = useMemo(() => largestPrimeFactor(item.total), [item.total]);
  const unitSize = useMemo(() => item.total / unitsAuto, [item.total, unitsAuto]);
  const purposeText = `${store.label} • ${item.label.split(' (')[0]}`;

  useEffect(() => {
    setForm(f => ({ ...f, units: unitsAuto }));
  }, [unitsAuto, form.itemKey]);

  // --- Load signals ---
  const load = async () => {
  const { data, error } = await supabase.from('signals').select('*').order('window_start', { ascending: true });
  if (!error) {
    setSignals((data ?? []).map(s => ({
      ...s,
      units_claimed: Number.isFinite(+s.units_claimed) ? +s.units_claimed : 0,
      units_total:   Number.isFinite(+s.units_total)   ? +s.units_total   : 0,
    })));
  }
};

  useEffect(() => {
    load();
    const ch = supabase
      .channel('signals-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, load)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  // --- Posting a new signal ---
  const postSignal = async (e: React.FormEvent) => {
  e.preventDefault();

  const start = new Date(nowRounded.getTime() + mins(form.leaveInMin));
  const end   = new Date(start.getTime() + hours(form.windowHours));

  // ✅ create local variables with distinct names
  const startIso   = start.toISOString();
  const endIso     = end.toISOString();
  const expiresIso = new Date(end.getTime() + hours(2)).toISOString();

  const units_total = Math.max(1, Math.min(24, Number(form.units) || 1));

  // (optional) sanity check
  // console.log({startIso, endIso, expiresIso, units_total});

  const { error } = await supabase.from('signals').insert({
    direction: form.direction,
    purpose: purposeText,
    window_start: startIso,   // ✅ use the locals
    window_end: endIso,
    units_total,
    expires_at: expiresIso,
  });

  if (error) {
    console.error(error);
    alert('Insert failed: ' + error.message);
  } else {
    await load();
  }
};


  // --- Claim a unit ---
  const claimOne = async (s: Signal) => {
    const expired = dayjs().isAfter(dayjs(s.expires_at));
    if (s.units_claimed >= s.units_total || expired) return;
    await supabase.from('claims').insert({ signal_id: s.id, unit_count: 1 });
    await supabase.rpc('increment_claimed', { p_signal_id: s.id, p_count: 1 });
  };

const submitFeedback = async (signalId: string, fb: 'ok' | 'not_ok', notes: string) => {
  try {
    setSubmitting(p => ({ ...p, [signalId]: true }));
    const { error } = await supabase.from('feedback').insert({
      signal_id: signalId,
      feedback: fb,
      notes: notes || null,
    });
    if (error) throw error;
    await load();
  } finally {
    setSubmitting(p => ({ ...p, [signalId]: false }));
  }
};


  // --- Feedback update ---
  const updateFeedback = async (id: string, value: 'ok' | 'not_ok', notes: string = '') => {
    await supabase.from('claims').update({
      feedback: value,
      feedback_notes: notes,
    }).eq('id', id);
    await load();
  };


  // --- Filter active signals (hide expired ones) ---
  const now = dayjs();
  const activeSignals = signals.filter(s => now.isBefore(dayjs(s.expires_at)));


  // --- Small reusable card wrapper ---
  const Card: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    <div style={{ padding: 12, background: '#2C2C2C', borderRadius: 8 }}>{children}</div>;

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
      <div style={{ opacity: 0.6, marginBottom: 12, fontSize: 13, textAlign: 'left' }}>
  No logins. No stored personal data. Trust.
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
                onChange={(e) => setForm(f => ({ ...f, direction: e.target.value as Direction }))}
              >
                <option>north</option><option>south</option>
                <option>east</option><option>west</option>
              </select>
            </label>

            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
              <label>
                Store
                <select
                  value={form.storeKey}
                  onChange={(e) => setForm(f => ({ ...f, storeKey: e.target.value, itemKey: CATALOG.costco.items[0].key }))}
                >
                  <option value="costco">Costco</option>
                </select>
              </label>
              <label>
                Item
                <select
                  value={form.itemKey}
                  onChange={(e) => setForm(f => ({ ...f, itemKey: e.target.value }))}
                >
                  {store.items.map(i => (
                    <option key={i.key} value={i.key}>{i.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
              <label>
                Leave in
                <select
                  value={form.leaveInMin}
                  onChange={(e) => setForm(f => ({ ...f, leaveInMin: Number(e.target.value) }))}
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
                  onChange={(e) => setForm(f => ({ ...f, windowHours: Number(e.target.value) }))}
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

            <div style={{ fontSize: 12, opacity: 0.8, marginTop: -6 }}>
              {item.total} total → {form.units} units • {unitSize} each
            </div>

          <label>
  Payment methods
  <div style={{ display: 'flex', gap: 10 }}>
    {['Venmo', 'Cash App', 'Zelle', 'Cash'].map((method) => (
      <label key={method} style={{ fontSize: 14 }}>
        <input
          type="checkbox"
          checked={form.payments?.includes(method) || false}
          onChange={(e) => {
            const selected = form.payments || [];
            setForm(f => ({
              ...f,
              payments: e.target.checked
                ? [...selected, method]
                : selected.filter(m => m !== method)
            }));
          }}
        />
        {method}
      </label>
    ))}
  </div>
</label>

            <button type="submit">Go (post shared run)</button>
          </form>
        </Card>
      )}

      {/* Requester list */}
      {role === 'requester' && (
        <>
          <h2 style={{ marginTop: 16 }}>Active Signals</h2>

          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
            {activeSignals.map((s) => (
              <li key={s.id}>
                <Card>
                  {/* top row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <div><b>{s.purpose}</b> • {s.direction.toUpperCase()}</div>
                    <div style={{ opacity: 0.8 }}>
                      {dayjs(s.window_start).format('h:mm a')}–{dayjs(s.window_end).format('h:mm a')}
                    </div>
                  </div>

                  {/* units */}
                  <div style={{ marginTop: 6 }}>
                    Units: {s.units_claimed}/{s.units_total}
                  </div>

                  {/* claim button */}
                  <button
                    style={{ marginTop: 8 }}
                    disabled={s.units_claimed >= s.units_total || dayjs().isAfter(dayjs(s.expires_at))}
                    onClick={() => claimOne(s)}
                  >
                    {s.units_claimed >= s.units_total ? 'Full' : 'Claim 1 unit'}
                  </button>

                  {/* feedback */}
                  {!s.feedback && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ marginBottom: 6 }}>Feedback</div>
                      <button
                        onClick={() =>
                          submitFeedback(s.id, 'ok', noteRefs.current[s.id]?.value || '')
                        }
                      >
                        OK
                      </button>
                      <button
                        style={{ marginLeft: 8 }}
                        onClick={() =>
                          submitFeedback(s.id, 'not_ok', noteRefs.current[s.id]?.value || '')
                        }
                      >
                        Not OK
                      </button>

                      <textarea
                        placeholder="How could this be better? (optional)"
                        ref={(el) => (noteRefs.current[s.id] = el)}
                        defaultValue={s.feedback_notes ?? ''}
                        rows={2}
                        style={{ width: '100%', marginTop: 8, background: '#2e2e2e', color: '#e0e0e0', resize: 'vertical' }}
                        onKeyDown={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}

                  {s.feedback && (
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
                      Feedback recorded: {s.feedback.toUpperCase()}
                      {s.feedback_notes && ` — "${s.feedback_notes}"`}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  ); // closes return
} // closes function
