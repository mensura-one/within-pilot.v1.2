"use client";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type RequestRow = {
  id: string;
  purpose: string;
  direction: string | null;
  window_start: string | null;
  window_end: string | null;
  payment_method: string | null;
  status: string | null;
};

export default function RequesterView() {
  const [purpose, setPurpose] = useState("");
  const [direction, setDirection] = useState("north");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [requests, setRequests] = useState<RequestRow[]>([]);

  const load = async () => {
    const { data } = await supabase
      .from("requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    setRequests(data || []);
  };

  useEffect(() => { load(); }, []);

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("requests").insert([{
      purpose,
      direction,
      payment_method: paymentMethod || null,
      window_start: windowStart || null,
      window_end: windowEnd || null,
    }]);
    if (error) { alert(error.message); return; }
    setPurpose(""); setPaymentMethod(""); setWindowStart(""); setWindowEnd("");
    await load();
    alert("Request posted!");
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <h2 style={{ marginTop: 8 }}>Request a Shared Run</h2>

      <form onSubmit={post} style={{ display: "grid", gap: 8, background: "#2c2c2c", padding: 12, borderRadius: 8 }}>
        <label>What do you need?</label>
        <input value={purpose} onChange={e=>setPurpose(e.target.value)} placeholder="toilet paper, paper towels" />

        <label>Direction</label>
        <select value={direction} onChange={e=>setDirection(e.target.value)}>
          <option value="north">North</option><option value="south">South</option>
          <option value="east">East</option><option value="west">West</option>
        </select>

        <label>Payment Method (BYOP)</label>
        <select value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value)}>
          <option value="">Select</option>
          <option value="Venmo">Venmo</option>
          <option value="CashApp">Cash App</option>
          <option value="Zelle">Zelle</option>
          <option value="Other">Other</option>
        </select>

        <label>Window Start</label>
        <input type="datetime-local" value={windowStart} onChange={e=>setWindowStart(e.target.value)} />

        <label>Window End</label>
        <input type="datetime-local" value={windowEnd} onChange={e=>setWindowEnd(e.target.value)} />

        <button type="submit">Post Request</button>
      </form>

      <h3>Active Requests</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {requests.map(r => (
          <div key={r.id} style={{ background: "#2c2c2c", padding: 10, borderRadius: 8 }}>
            <div><strong>{r.purpose}</strong> • {r.direction || "—"}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {r.payment_method ? `BYOP: ${r.payment_method}` : "BYOP"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
