'use client';
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { supabase } from '@/lib/supabase';

/** ===== Config & helpers ===== */
const BUCKET_MIN = 15; // change to 10 if you prefer
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

// Minimal catalog; tweak counts as needed
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
  const [signals, setSignals] = useState<Signal[]>([]);

  // Defaults
  const nowRounded = roundUpToBucket(new Date(), BUCKET_MIN);
  const [form, setForm] = useState({
    direction: 'north' as Direction,
    storeKey: 'costco',
    itemKey: 'tp30',     // default item
    leaveInMin: 0,       // 0, 15, 30, 45, 60
    windowHours: 2,      // 1 or 2
    units: 6,            // will be auto-set; kept for display
  });

  // Derive purpose + units from store/item
  const store = CATALOG[form.storeKey as keyof typeof CATALOG];
  const item = store.items.find(i => i.key === form.itemKey)!;
  const unitsAuto = useMemo(() => largestPrimeFactor(item.total), [item.total]);
  const unitSize = useMemo(() => item.total / unitsAuto, [item.total, unitsAuto]);
  const purposeText = `${store.label} • ${item.label.split(' (')[0]}`; // e.g., "Costco • Toilet paper"

  useEffect(() => {
    // reflect computed units in the UI (read-only field)
    setForm(f => ({ ...f, units: unitsAuto }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unitsAuto, form.itemKey]);

  const load = async () => {
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .order('window_start', { ascending: true });
    if (!error) setSignals(data || []);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('signals-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const postSignal = async (e: React.FormEvent) => {
    e.preventDefault();

    const start = new Date(nowRounded.getTime() + mins(form.leaveInMin));
    const end = new Date(start.getTime() + hours(form.windowHours));

    const window_start = start.toISOString();
    const window_end   = end.toISOString();
    const expires_at   = new Date(end.getTime() + hours(2)).toISOString();

    const units_total = Math.max(1, Math.min(24, Number(form.units) || 1));

    const { error } = await supabase.from('signals').insert({
      direction: form.direction,
      purpose: purposeText,     // include item in purpose
      window_start,
      window_end,
      units_total,              // e.g., 5 for TP30 → 5 units of 6
      expires_at,
    });

    if (error) {
      alert('Insert failed: ' + error.message);
      console.error(error);
    } else {
      await load();
    }
  };

  const claimOne = async (s: Signal) => {
    const expired = dayjs().isAfter(dayjs(s.expires_at));
    if (s.units_claimed >= s.units_total || expired) return;
    await supabase.from('claims').insert({ signal_id: s.id, unit_count: 1 });
    await supabase.rpc('increment_claimed', { p_signal_id: s.id, p_count: 1 });
  };

  const Card: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    <div style={{ padding: 12, background: '#2C2C2C', borderRadius: 8 }}>{children}</div>;

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
      <h1 style={{ marginBottom: 4 }}>within • Pilot Shared Runs</h1>
      <div style={{ opacity: 0.8, marginBottom: 12, fontSize: 14 }}>
        RM₁: no login, no stored personal data — live signal only.
      </div>

      <Card>
        <form onSubmit={postSignal} style={{ display: 'grid', gap: 10 }}>
          <label>
            Direction
            <select
              value={form.direction}
              onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value as Direction }))}
            >
              <option>north</option><option>south</option><option>east</option><option>west</option>
            </select>
          </label>

          {/* Store + Item */}
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
            <label>
              Store
              <select
                value={form.storeKey}
                onChange={(e) => setForm((f) => ({ ...f, storeKey: e.target.value, itemKey: CATALOG.costco.items[0].key }))}
              >
                <option value="costco">Costco</option>
                {/* Add H-E-B / Target later */}
              </select>
            </label>

            <label>
              Item
              <select
                value={form.itemKey}
                onChange={(e) => setForm((f) => ({ ...f, itemKey: e.target.value }))}
              >
                {store.items.map(i => (
                  <option key={i.key} value={i.key}>{i.label}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Time controls */}
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
            <label>
              Leave in
              <select
                value={form.leaveInMin}
                onChange={(e) => setForm((f) => ({ ...f, leaveInMin: Number(e.target.value) }))}
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
                onChange={(e) => setForm((f) => ({ ...f, windowHours: Number(e.target.value) }))}
              >
                <option value={1}>1 hour</option>
                <option value={2}>2 hours</option>
              </select>
            </label>
          </div>

          {/* Units (auto) */}
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

          <button type="submit">Go (post shared run)</button>

          {/* Preview of computed times */}
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Start ~ {toLocalInput(new Date(nowRounded.getTime() + mins(form.leaveInMin)))} |
            End ~ {toLocalInput(new Date(nowRounded.getTime() + mins(form.leaveInMin) + hours(form.windowHours)))}
          </div>
        </form>
      </Card>

      <h2 style={{ marginTop: 16 }}>Active Signals</h2>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
        {signals.map((s) => (
          <li key={s.id}>
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div><b>{s.purpose}</b> • {s.direction.toUpperCase()}</div>
                <div style={{ opacity: 0.8 }}>
                  {dayjs(s.window_start).format('h:mm a')}–{dayjs(s.window_end).format('h:mm a')}
                </div>
              </div>
              <div style={{ marginTop: 6 }}>Units: {s.units_claimed}/{s.units_total}</div>
              <button
                style={{ marginTop: 8 }}
                disabled={s.units_claimed >= s.units_total || dayjs().isAfter(dayjs(s.expires_at))}
                onClick={() => claimOne(s)}
              >
                {s.units_claimed >= s.units_total ? 'Full' : 'Claim 1 unit'}
              </button>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
}
