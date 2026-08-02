import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";

// One shared board for the whole group. Change this if you ever run two crews.
const SLUG = "main";
const todayISO = () => new Date().toISOString().slice(0, 10);
const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  Date.now().toString(36) + Math.random().toString(36).slice(2);
const money = (n) => "$" + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};
const prettyDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const prettyTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":");
  let hr = parseInt(h, 10);
  const ap = hr >= 12 ? "PM" : "AM";
  hr = hr % 12 || 12;
  return `${hr}:${m} ${ap}`;
};

const timeRange = (s) => {
  if (!s.time) return "TBD";
  return s.endTime ? `${prettyTime(s.time)} – ${prettyTime(s.endTime)}` : prettyTime(s.time);
};

// per-session math: new sessions store totalCost split across attendees;
// legacy sessions stored a per-player "cost" — fall back to that.
const attCount = (s) => (s.attendees || []).length;
const perPlayer = (s) => {
  if (s.totalCost != null) {
    const n = attCount(s);
    return n > 0 ? num(s.totalCost) / n : num(s.totalCost);
  }
  return num(s.cost);
};
const sessionTotal = (s) => {
  if (s.totalCost != null) return num(s.totalCost);
  return num(s.cost) * attCount(s);
};

const empty = { players: [], sessions: [], payments: [], courts: [], pin: "" };

const DEFAULT_COURTS = [
  "Tyngsborough Sports Center",
  "TJL Training",
  "The Mill Works",
  "Game Time Sports and Fitness",
];

export default function CourtDues() {
  const [data, setData] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [saveErr, setSaveErr] = useState("");
  const [mode, setMode] = useState("view"); // view | manage | pin
  const [unlocked, setUnlocked] = useState(false);
  const [pinTry, setPinTry] = useState("");
  const [pinErr, setPinErr] = useState("");
  const [tab, setTab] = useState("roster"); // roster | sessions | courts | settings
  const [viewTab, setViewTab] = useState("standings"); // standings | upcoming
  const [copied, setCopied] = useState(false);

  // ---- load + live updates ----
  useEffect(() => {
    (async () => {
      let loaded = null;
      try {
        const { data: row, error } = await supabase
          .from("boards")
          .select("data")
          .eq("slug", SLUG)
          .single();
        if (!error && row) loaded = row.data;
      } catch (e) {
        /* no board yet — start fresh */
      }
      let next = { ...empty, ...(loaded || {}) };
      if (!next.seeded && (!next.courts || next.courts.length === 0)) {
        next = {
          ...next,
          courts: DEFAULT_COURTS.map((name) => ({ id: uid(), name, cost: 0 })),
          seeded: true,
        };
        try {
          await supabase.from("boards").upsert({ slug: SLUG, data: next });
        } catch (e) {
          /* seeding is best-effort */
        }
      }
      setData(next);
      setLoading(false);
    })();

    // Push live changes to anyone else viewing the board.
    // (Harmless no-op if you haven't enabled Realtime for the table.)
    const channel = supabase
      .channel("courtdues-board")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "boards", filter: `slug=eq.${SLUG}` },
        (payload) => {
          if (payload.new && payload.new.data) setData({ ...empty, ...payload.new.data });
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const persist = async (next) => {
    setData(next);
    try {
      const { error } = await supabase
        .from("boards")
        .upsert({ slug: SLUG, data: next, updated_at: new Date().toISOString() });
      if (error) throw error;
      setSaveErr("");
    } catch (e) {
      setSaveErr("Couldn't save to the shared board. Check your connection and try that again.");
    }
  };

  // ---- derived totals ----
  const totals = useMemo(() => {
    const owedBy = {};
    data.players.forEach((p) => (owedBy[p.id] = 0));
    data.sessions.forEach((s) => {
      const share = perPlayer(s);
      (s.attendees || []).forEach((pid) => {
        if (owedBy[pid] != null) owedBy[pid] += share;
      });
    });
    const paidBy = {};
    data.players.forEach((p) => (paidBy[p.id] = 0));
    data.payments.forEach((pay) => {
      if (paidBy[pay.playerId] != null) paidBy[pay.playerId] += num(pay.amount);
    });
    const rows = data.players.map((p) => {
      const owed = owedBy[p.id] || 0;
      const paid = paidBy[p.id] || 0;
      return { ...p, owed, paid, balance: owed - paid };
    });
    rows.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    const collected = rows.reduce((s, r) => s + r.paid, 0);
    const billed = rows.reduce((s, r) => s + r.owed, 0);
    return { rows, collected, billed, outstanding: billed - collected };
  }, [data]);

  const nextGame = useMemo(() => {
    const t = todayISO();
    const upcoming = [...data.sessions]
      .filter((s) => s.date && s.date >= t)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
    return upcoming[0] || null;
  }, [data.sessions]);

  // ---- mutations ----
  const addPlayer = (name) => {
    const nm = name.trim();
    if (!nm) return;
    persist({ ...data, players: [...data.players, { id: uid(), name: nm }] });
  };
  const removePlayer = (id) =>
    persist({
      ...data,
      players: data.players.filter((p) => p.id !== id),
      payments: data.payments.filter((p) => p.playerId !== id),
      sessions: data.sessions.map((s) => ({
        ...s,
        attendees: (s.attendees || []).filter((pid) => pid !== id),
      })),
    });
  const recordPayment = (playerId, amount) => {
    const amt = num(amount);
    if (amt === 0) return;
    persist({
      ...data,
      payments: [...data.payments, { id: uid(), playerId, amount: amt, date: todayISO() }],
    });
  };
  const addSession = (s) =>
    persist({ ...data, sessions: [...data.sessions, { id: uid(), ...s }] });
  const updateSession = (id, patch) =>
    persist({
      ...data,
      sessions: data.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  const removeSession = (id) =>
    persist({ ...data, sessions: data.sessions.filter((s) => s.id !== id) });
  const duplicateSession = (id) => {
    const s = data.sessions.find((x) => x.id === id);
    if (!s) return;
    const { id: _drop, ...rest } = s;
    const d = new Date((s.date || todayISO()) + "T00:00:00");
    d.setDate(d.getDate() + 7); // default the copy to next week
    persist({
      ...data,
      sessions: [...data.sessions, { ...rest, id: uid(), date: d.toISOString().slice(0, 10) }],
    });
  };

  const addCourt = (name, cost) => {
    const nm = (name || "").trim();
    if (!nm) return;
    persist({ ...data, courts: [...data.courts, { id: uid(), name: nm, cost: num(cost) }] });
  };
  const updateCourt = (id, patch) =>
    persist({
      ...data,
      courts: data.courts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  const removeCourt = (id) =>
    persist({ ...data, courts: data.courts.filter((c) => c.id !== id) });

  const setPin = (pin) => persist({ ...data, pin });

  const tryUnlock = () => {
    if (!data.pin || pinTry === data.pin) {
      setUnlocked(true);
      setMode("manage");
      setPinErr("");
      setPinTry("");
    } else {
      setPinErr("That PIN doesn't match.");
    }
  };
  const enterManage = () => {
    if (data.pin && !unlocked) setMode("pin");
    else {
      setUnlocked(true);
      setMode("manage");
    }
  };

  const copyStandings = () => {
    const lines = [];
    lines.push("🏀 COURT DUES");
    if (nextGame)
      lines.push(
        `Next run: ${prettyDate(nextGame.date)}${nextGame.time ? " " + prettyTime(nextGame.time) : ""}${
          nextGame.place ? " @ " + nextGame.place : ""
        } — ${money(perPlayer(nextGame))}/player`
      );
    lines.push("");
    totals.rows.forEach((r) => {
      const status =
        r.balance > 0.001
          ? `owes ${money(r.balance)}`
          : r.balance < -0.001
          ? `credit ${money(-r.balance)}`
          : "square ✅";
      lines.push(`${r.name}: ${status}  (paid ${money(r.paid)} of ${money(r.owed)})`);
    });
    lines.push("");
    lines.push(`Outstanding total: ${money(totals.outstanding)}`);
    const text = lines.join("\n");
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => {}
    );
  };

  if (loading)
    return (
      <div className="min-h-screen bg-stone-950 flex items-center justify-center text-stone-500 font-mono text-sm">
        Loading the board…
      </div>
    );

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100">
      <div className="mx-auto max-w-md px-4 pb-24 pt-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight leading-none">
              COURT<span className="text-orange-500">DUES</span>
            </h1>
            <p className="text-[11px] uppercase tracking-widest text-stone-500 mt-1">
              Pickup run ledger
            </p>
          </div>
          {mode !== "manage" ? (
            <button
              onClick={enterManage}
              className="text-xs font-semibold px-3 py-2 rounded-lg bg-stone-800 hover:bg-stone-700 active:bg-stone-600 transition-colors"
            >
              Manage
            </button>
          ) : (
            <button
              onClick={() => setMode("view")}
              className="text-xs font-semibold px-3 py-2 rounded-lg bg-orange-500 hover:bg-orange-400 text-stone-950 transition-colors"
            >
              Done
            </button>
          )}
        </div>

        {saveErr && (
          <div className="mt-4 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
            {saveErr}
          </div>
        )}

        {/* PIN gate */}
        {mode === "pin" && (
          <div className="mt-6 rounded-2xl border border-stone-800 bg-stone-900 p-5">
            <p className="text-sm text-stone-300 mb-3">Enter the manager PIN to edit.</p>
            <div className="flex gap-2">
              <input
                type="password"
                inputMode="numeric"
                value={pinTry}
                onChange={(e) => setPinTry(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && tryUnlock()}
                placeholder="PIN"
                className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
              <button
                onClick={tryUnlock}
                className="px-4 py-2 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400"
              >
                Unlock
              </button>
            </div>
            {pinErr && <p className="text-xs text-rose-400 mt-2">{pinErr}</p>}
            <button
              onClick={() => setMode("view")}
              className="text-xs text-stone-500 mt-3 hover:text-stone-300"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ===== VIEW MODE ===== */}
        {mode === "view" && (
          <>
            <InstallPrompt />
            <div className="mt-5 flex gap-1 rounded-xl bg-stone-900 p-1 text-sm">
              {[
                ["standings", "Standings"],
                ["upcoming", "Upcoming"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setViewTab(k)}
                  className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
                    viewTab === k ? "bg-orange-500 text-stone-950" : "text-stone-400 hover:text-stone-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {viewTab === "standings" && (
              <>
                <NextGameCard game={nextGame} />
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <Stat label="Collected" value={money(totals.collected)} tone="emerald" />
                  <Stat label="Outstanding" value={money(totals.outstanding)} tone="orange" />
                </div>

                <div className="mt-6 flex items-center justify-between">
                  <h2 className="text-xs uppercase tracking-widest text-stone-500">Standings</h2>
                  <button
                    onClick={copyStandings}
                    className="text-xs font-semibold text-orange-400 hover:text-orange-300"
                  >
                    {copied ? "Copied ✓" : "Copy for group chat"}
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {totals.rows.length === 0 && (
                    <EmptyNote text="No players yet. Tap Manage to add your squad." />
                  )}
                  {totals.rows.map((r) => (
                    <StandingRow key={r.id} r={r} />
                  ))}
                </div>
              </>
            )}

            {viewTab === "upcoming" && (
              <UpcomingSessions sessions={data.sessions} players={data.players} />
            )}
          </>
        )}

        {/* ===== MANAGE MODE ===== */}
        {mode === "manage" && (
          <>
            <div className="mt-5 flex gap-1 rounded-xl bg-stone-900 p-1 text-sm">
              {[
                ["roster", "Roster"],
                ["sessions", "Sessions"],
                ["courts", "Courts"],
                ["settings", "Settings"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
                    tab === k ? "bg-orange-500 text-stone-950" : "text-stone-400 hover:text-stone-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "roster" && (
              <RosterManager
                rows={totals.rows}
                onAdd={addPlayer}
                onRemove={removePlayer}
                onPay={recordPayment}
              />
            )}
            {tab === "sessions" && (
              <SessionsManager
                players={data.players}
                courts={data.courts}
                sessions={[...data.sessions].sort((a, b) => (b.date || "").localeCompare(a.date || ""))}
                onAdd={addSession}
                onUpdate={updateSession}
                onRemove={removeSession}
                onDuplicate={duplicateSession}
                onAddCourt={addCourt}
                goToCourts={() => setTab("courts")}
              />
            )}
            {tab === "courts" && (
              <CourtsManager
                courts={data.courts}
                onAdd={addCourt}
                onUpdate={updateCourt}
                onRemove={removeCourt}
              />
            )}
            {tab === "settings" && <SettingsPanel pin={data.pin} onSetPin={setPin} />}
          </>
        )}

        <p className="mt-10 text-center text-[10px] text-stone-600 leading-relaxed">
          Shared board — everyone with the link sees these numbers.
          <br />
          The PIN is a light lock for a trusted group, not real security.
        </p>
      </div>
    </div>
  );
}

/* ---------- View pieces ---------- */

function NextGameCard({ game }) {
  if (!game)
    return (
      <div className="mt-5 rounded-2xl border border-dashed border-stone-800 bg-stone-900/40 p-5 text-center">
        <p className="text-sm text-stone-400">No game scheduled yet.</p>
      </div>
    );
  const share = perPlayer(game);
  return (
    <div className="mt-5 rounded-2xl border border-orange-500/30 bg-gradient-to-br from-stone-900 to-stone-900/40 p-5">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
        <span className="text-[11px] uppercase tracking-widest text-orange-400 font-semibold">
          Next run
        </span>
      </div>
      <div className="mt-2 text-2xl font-black tracking-tight">{prettyDate(game.date)}</div>
      <div className="mt-1 text-stone-300 text-sm">{timeRange(game)}</div>
      {game.place && (
        <div className="mt-1 flex items-center gap-1.5 text-sm text-stone-400">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-orange-500" fill="currentColor">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
          </svg>
          <span>{game.place}</span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <div className="inline-flex items-baseline gap-1 rounded-lg bg-stone-950/60 px-3 py-1.5">
          <span className="font-mono text-lg font-bold text-orange-400">{money(share)}</span>
          <span className="text-xs text-stone-500">/ player</span>
        </div>
        <div className="text-[11px] text-stone-500">
          {attCount(game)} player{attCount(game) === 1 ? "" : "s"} in
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === "emerald" ? "text-emerald-400" : "text-orange-400";
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900 p-3">
      <div className="text-[11px] uppercase tracking-widest text-stone-500">{label}</div>
      <div className={`mt-1 font-mono text-xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function StandingRow({ r }) {
  const pct = r.owed > 0 ? Math.min(100, (r.paid / r.owed) * 100) : r.paid > 0 ? 100 : 0;
  const square = Math.abs(r.balance) < 0.001;
  const credit = r.balance < -0.001;
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900 p-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{r.name}</span>
        <span
          className={`font-mono font-bold ${
            square ? "text-emerald-400" : credit ? "text-sky-400" : "text-orange-400"
          }`}
        >
          {square ? "SQUARE" : credit ? `+${money(-r.balance)}` : money(r.balance)}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-stone-800">
        <div
          className={`h-full rounded-full ${square || credit ? "bg-emerald-500" : "bg-orange-500"}`}
          style={{ width: pct + "%" }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-stone-500">
        <span>paid {money(r.paid)}</span>
        <span>of {money(r.owed)}</span>
      </div>
    </div>
  );
}

function EmptyNote({ text }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-800 bg-stone-900/40 p-5 text-center text-sm text-stone-500">
      {text}
    </div>
  );
}

/* ---------- Add to home screen prompt ---------- */

function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [isIOS, setIsIOS] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Android: use the captured install event (or listen for a later one).
    if (window.__bipEvent) setDeferred(window.__bipEvent);
    const onBIP = (e) => {
      e.preventDefault();
      window.__bipEvent = e;
      setDeferred(e);
    };
    const onInstalled = () => setDismissed(true);
    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);

    const ua = window.navigator.userAgent || "";
    setIsIOS(/iphone|ipad|ipod/i.test(ua) && !/crios|fxios/i.test(ua)); // Safari on iOS only
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        window.navigator.standalone === true
    );

    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Hide if already installed, dismissed, or we can't actually help (e.g. desktop).
  if (standalone || dismissed) return null;
  if (!deferred && !isIOS) return null;

  const onClick = async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      window.__bipEvent = null;
      setDeferred(null);
      setDismissed(true);
    } else {
      setShowHelp((v) => !v);
    }
  };

  return (
    <div className="mt-5 rounded-xl border border-orange-500/30 bg-stone-900 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-stone-300">📲 Add Court Dues to your home screen</div>
        <div className="flex items-center gap-1">
          <button
            onClick={onClick}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-orange-500 text-stone-950 hover:bg-orange-400"
          >
            {deferred ? "Add" : "How?"}
          </button>
          <button
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
            className="text-stone-500 hover:text-stone-300 text-sm px-1.5"
          >
            ✕
          </button>
        </div>
      </div>
      {showHelp && isIOS && (
        <div className="mt-2 text-xs text-stone-400 leading-relaxed">
          Tap the <b className="text-stone-200">Share</b> button (the square with an up arrow) at
          the bottom of Safari, scroll down, and choose{" "}
          <b className="text-stone-200">Add to Home Screen</b>.
        </div>
      )}
    </div>
  );
}

/* ---------- Upcoming sessions (viewer) ---------- */

function UpcomingSessions({ sessions, players }) {
  const t = todayISO();
  const pmap = Object.fromEntries(players.map((p) => [p.id, p.name]));
  const upcoming = [...sessions]
    .filter((s) => s.date && s.date >= t)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));

  if (upcoming.length === 0)
    return (
      <div className="mt-4">
        <EmptyNote text="No upcoming sessions scheduled." />
      </div>
    );

  return (
    <div className="mt-4 space-y-3">
      {upcoming.map((s) => {
        const names = (s.attendees || []).map((id) => pmap[id]).filter(Boolean);
        return (
          <div key={s.id} className="rounded-2xl border border-stone-800 bg-stone-900 p-4">
            <div className="flex items-baseline justify-between">
              <div className="text-lg font-black tracking-tight">{prettyDate(s.date)}</div>
              <div className="inline-flex items-baseline gap-1 rounded-lg bg-stone-950/60 px-2.5 py-1">
                <span className="font-mono text-sm font-bold text-orange-400">
                  {money(perPlayer(s))}
                </span>
                <span className="text-[11px] text-stone-500">/ player</span>
              </div>
            </div>
            <div className="mt-1 text-sm text-stone-300">{timeRange(s)}</div>
            {s.place && (
              <div className="mt-1 flex items-center gap-1.5 text-sm text-stone-400">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-orange-500" fill="currentColor">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" />
                </svg>
                <span>{s.place}</span>
              </div>
            )}
            <div className="mt-2 text-[11px] text-stone-500">
              {money(sessionTotal(s))} court · {attCount(s)} player{attCount(s) === 1 ? "" : "s"} in
            </div>
            {names.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {names.map((n) => (
                  <span
                    key={n}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-stone-800 text-stone-300"
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Roster manager ---------- */

function RosterManager({ rows, onAdd, onRemove, onPay }) {
  const [name, setName] = useState("");
  const [payFor, setPayFor] = useState(null);
  const [payAmt, setPayAmt] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onAdd(name);
              setName("");
            }
          }}
          placeholder="Add player name"
          className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
        />
        <button
          onClick={() => {
            onAdd(name);
            setName("");
          }}
          className="px-4 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400"
        >
          Add
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {rows.length === 0 && <EmptyNote text="No players yet." />}
        {rows.map((r) => (
          <div key={r.id} className="rounded-xl border border-stone-800 bg-stone-900 p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{r.name}</div>
                <div className="text-[11px] text-stone-500 font-mono">
                  paid {money(r.paid)} · owes{" "}
                  <span className={r.balance > 0.001 ? "text-orange-400" : "text-emerald-400"}>
                    {money(Math.max(0, r.balance))}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setPayFor(payFor === r.id ? null : r.id);
                    setPayAmt("");
                  }}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
                >
                  Log payment
                </button>
                <button
                  onClick={() => setConfirmDel(confirmDel === r.id ? null : r.id)}
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-stone-800 text-stone-400 hover:bg-rose-900/40 hover:text-rose-300"
                  aria-label={`Remove ${r.name}`}
                >
                  ✕
                </button>
              </div>
            </div>

            {payFor === r.id && (
              <div className="mt-3 flex gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  value={payAmt}
                  onChange={(e) => setPayAmt(e.target.value)}
                  placeholder={r.balance > 0 ? `e.g. ${money(r.balance).slice(1)}` : "Amount"}
                  className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
                <button
                  onClick={() => {
                    onPay(r.id, payAmt);
                    setPayFor(null);
                    setPayAmt("");
                  }}
                  className="px-4 rounded-lg bg-emerald-500 text-stone-950 text-sm font-semibold hover:bg-emerald-400"
                >
                  Save
                </button>
              </div>
            )}

            {confirmDel === r.id && (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-rose-950/40 border border-rose-900 px-3 py-2">
                <span className="text-xs text-rose-300">Remove {r.name} and their history?</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDel(null)}
                    className="text-xs px-2 py-1 rounded text-stone-400"
                  >
                    Keep
                  </button>
                  <button
                    onClick={() => {
                      onRemove(r.id);
                      setConfirmDel(null);
                    }}
                    className="text-xs px-3 py-1 rounded bg-rose-600 text-white font-semibold"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Sessions manager ---------- */

function SessionsManager({ players, courts, sessions, onAdd, onUpdate, onRemove, onDuplicate, onAddCourt, goToCourts }) {
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("18:00");
  const [endTime, setEndTime] = useState("20:00");
  const [place, setPlace] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [courtId, setCourtId] = useState(null);
  const [other, setOther] = useState(false);
  const [attendees, setAttendees] = useState([]);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    setAttendees((prev) => prev.filter((id) => players.some((p) => p.id === id)));
  }, [players]);

  const handleCourtSelect = (val) => {
    if (val === "__other__") {
      setOther(true);
      setCourtId(null);
      setPlace("");
    } else if (val === "") {
      setOther(false);
      setCourtId(null);
      setPlace("");
    } else {
      const c = courts.find((x) => x.id === val);
      if (c) {
        setOther(false);
        setCourtId(c.id);
        setPlace(c.name);
        if (num(c.cost) > 0) setTotalCost(String(c.cost));
      }
    }
  };

  const toggle = (id) =>
    setAttendees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));

  const nameMatchesCourt = courts.some(
    (c) => c.name.toLowerCase() === place.trim().toLowerCase()
  );
  const canSaveCourt = place.trim() && num(totalCost) > 0 && !nameMatchesCourt;

  const share =
    attendees.length && num(totalCost) > 0 ? num(totalCost) / attendees.length : 0;

  const save = () => {
    if (!date || num(totalCost) <= 0) return;
    onAdd({ date, time, endTime, place: place.trim(), totalCost: num(totalCost), attendees });
    setPlace("");
    setTotalCost("");
    setCourtId(null);
    setOther(false);
    setAttendees([]);
  };

  const pmap = Object.fromEntries(players.map((p) => [p.id, p.name]));

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-4">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">New session</div>

        {/* court dropdown */}
        <div className="mb-3">
          <Field label="Place">
            <select
              value={other ? "__other__" : courtId || ""}
              onChange={(e) => handleCourtSelect(e.target.value)}
              className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-2 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
            >
              <option value="">Select a court…</option>
              {courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__other__">Other…</option>
            </select>
          </Field>
          {other && (
            <input
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder="Type the court / gym name"
              className="mt-2 w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-2 text-sm outline-none focus:border-orange-500"
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-2 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
            />
          </Field>
          <Field label="Total court cost">
            <input
              type="number"
              inputMode="decimal"
              value={totalCost}
              onChange={(e) => setTotalCost(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-2 text-sm outline-none focus:border-orange-500"
            />
          </Field>
          <Field label="Start">
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-2 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
            />
          </Field>
          <Field label="End">
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-2 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
            />
          </Field>
        </div>

        {other && canSaveCourt && (
          <button
            onClick={() => onAddCourt(place, totalCost)}
            className="mt-2 text-xs text-orange-400 hover:text-orange-300"
          >
            + Save "{place.trim()}" as a court for next time
          </button>
        )}

        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-2">
            Who's in ({attendees.length})
          </div>
          {players.length === 0 ? (
            <p className="text-xs text-stone-500">Add players first on the Roster tab.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {players.map((p) => {
                const on = attendees.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                      on
                        ? "bg-orange-500 border-orange-500 text-stone-950 font-semibold"
                        : "bg-stone-800 border-stone-700 text-stone-400"
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {share > 0 && (
          <div className="mt-3 text-xs text-stone-400">
            Split ={" "}
            <span className="font-mono font-bold text-orange-400">{money(share)}</span> / player
          </div>
        )}

        <button
          onClick={save}
          disabled={num(totalCost) <= 0}
          className="mt-4 w-full rounded-lg bg-orange-500 text-stone-950 py-2.5 text-sm font-bold hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add session
        </button>
      </div>

      <div className="mt-4 space-y-2">
        {sessions.length === 0 && <EmptyNote text="No sessions logged yet." />}
        {sessions.map((s) => {
          const names = (s.attendees || []).map((id) => pmap[id]).filter(Boolean);
          const open = expanded === s.id;
          return (
            <div key={s.id} className="rounded-xl border border-stone-800 bg-stone-900 p-3">
              <button
                onClick={() => setExpanded(open ? null : s.id)}
                className="w-full flex items-center justify-between text-left"
              >
                <div>
                  <div className="font-semibold text-sm">
                    {prettyDate(s.date)} · {timeRange(s)}
                  </div>
                  <div className="text-[11px] text-stone-500">
                    {s.place || "No place"} · {money(sessionTotal(s))} court · {names.length} in ·{" "}
                    <span className="text-orange-400">{money(perPlayer(s))}/player</span>
                  </div>
                </div>
                <span className="text-stone-500 text-xs">{open ? "▲" : "▼"}</span>
              </button>

              {open && (
                <div className="mt-3 border-t border-stone-800 pt-3">
                  <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-2">
                    Details
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Date">
                      <input
                        type="date"
                        defaultValue={s.date}
                        onBlur={(e) => e.target.value && onUpdate(s.id, { date: e.target.value })}
                        className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
                      />
                    </Field>
                    <Field label="Total court cost">
                      <input
                        type="number"
                        inputMode="decimal"
                        defaultValue={s.totalCost != null ? s.totalCost : sessionTotal(s)}
                        onBlur={(e) => onUpdate(s.id, { totalCost: num(e.target.value) })}
                        className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm outline-none focus:border-orange-500"
                      />
                    </Field>
                    <Field label="Start">
                      <input
                        type="time"
                        defaultValue={s.time || ""}
                        onBlur={(e) => onUpdate(s.id, { time: e.target.value })}
                        className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
                      />
                    </Field>
                    <Field label="End">
                      <input
                        type="time"
                        defaultValue={s.endTime || ""}
                        onBlur={(e) => onUpdate(s.id, { endTime: e.target.value })}
                        className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
                      />
                    </Field>
                  </div>
                  <div className="mt-2">
                    <Field label="Place">
                      <select
                        value={
                          courts.some((c) => c.name === s.place)
                            ? s.place
                            : s.place
                            ? "__current__"
                            : ""
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "" || v === "__current__") return;
                          const c = courts.find((x) => x.name === v);
                          const patch = { place: v };
                          if (c && num(c.cost) > 0) patch.totalCost = num(c.cost);
                          onUpdate(s.id, patch);
                        }}
                        className="w-full rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm outline-none focus:border-orange-500 [color-scheme:dark]"
                      >
                        <option value="">Select a court…</option>
                        {courts.map((c) => (
                          <option key={c.id} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                        {s.place && !courts.some((c) => c.name === s.place) && (
                          <option value="__current__">{s.place} (custom)</option>
                        )}
                      </select>
                    </Field>
                  </div>

                  <div className="mt-3 text-[11px] uppercase tracking-widest text-stone-500 mb-2">
                    Attendance
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {players.map((p) => {
                      const on = (s.attendees || []).includes(p.id);
                      return (
                        <button
                          key={p.id}
                          onClick={() => {
                            const cur = s.attendees || [];
                            onUpdate(s.id, {
                              attendees: on ? cur.filter((x) => x !== p.id) : [...cur, p.id],
                            });
                          }}
                          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                            on
                              ? "bg-orange-500 border-orange-500 text-stone-950 font-semibold"
                              : "bg-stone-800 border-stone-700 text-stone-400"
                          }`}
                        >
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 flex items-center gap-4">
                    <button
                      onClick={() => {
                        onDuplicate(s.id);
                        setExpanded(null);
                      }}
                      className="text-xs font-semibold text-orange-400 hover:text-orange-300"
                    >
                      Duplicate to next week
                    </button>
                    <button
                      onClick={() => onRemove(s.id)}
                      className="text-xs text-rose-400 hover:text-rose-300"
                    >
                      Delete this session
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-widest text-stone-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/* ---------- Courts manager ---------- */

function CourtsManager({ courts, onAdd, onUpdate, onRemove }) {
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);

  const add = () => {
    if (!name.trim() || num(cost) <= 0) return;
    onAdd(name, cost);
    setName("");
    setCost("");
  };

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-4">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">New court</div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Court name"
            className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
          <input
            type="number"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="Total $"
            className="w-24 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <button
          onClick={add}
          disabled={!name.trim() || num(cost) <= 0}
          className="mt-3 w-full rounded-lg bg-orange-500 text-stone-950 py-2.5 text-sm font-bold hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Save court
        </button>
        <p className="mt-2 text-[11px] text-stone-500">
          Saved courts show up as one-tap buttons when you add a session. You can still tweak the
          cost for any night.
        </p>
      </div>

      <div className="mt-4 space-y-2">
        {courts.length === 0 && <EmptyNote text="No courts saved yet." />}
        {courts.map((c) => (
          <div key={c.id} className="rounded-xl border border-stone-800 bg-stone-900 p-3">
            <div className="flex items-center gap-2">
              <input
                defaultValue={c.name}
                onBlur={(e) => e.target.value.trim() && onUpdate(c.id, { name: e.target.value.trim() })}
                className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm font-semibold outline-none focus:border-orange-500"
              />
              <div className="flex items-center gap-1">
                <span className="text-stone-500 text-sm">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  defaultValue={c.cost}
                  onBlur={(e) => onUpdate(c.id, { cost: num(e.target.value) })}
                  className="w-20 rounded-lg bg-stone-800 border border-stone-700 px-2 py-1.5 text-sm outline-none focus:border-orange-500"
                />
              </div>
              <button
                onClick={() => setConfirmDel(confirmDel === c.id ? null : c.id)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-stone-800 text-stone-400 hover:bg-rose-900/40 hover:text-rose-300"
                aria-label={`Remove ${c.name}`}
              >
                ✕
              </button>
            </div>
            {confirmDel === c.id && (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-rose-950/40 border border-rose-900 px-3 py-2">
                <span className="text-xs text-rose-300">
                  Remove this court? Past sessions keep their costs.
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDel(null)}
                    className="text-xs px-2 py-1 rounded text-stone-400"
                  >
                    Keep
                  </button>
                  <button
                    onClick={() => {
                      onRemove(c.id);
                      setConfirmDel(null);
                    }}
                    className="text-xs px-3 py-1 rounded bg-rose-600 text-white font-semibold"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Settings ---------- */

function SettingsPanel({ pin, onSetPin }) {
  const [val, setVal] = useState(pin || "");
  const [saved, setSaved] = useState(false);
  return (
    <div className="mt-4 rounded-xl border border-stone-800 bg-stone-900 p-4">
      <div className="text-xs uppercase tracking-widest text-stone-500 mb-2">Manager PIN</div>
      <p className="text-xs text-stone-400 mb-3">
        Set a PIN so only you can unlock Manage mode. Leave it blank for no lock. This is a light
        guard for a trusted group, not real security.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="No PIN set"
          className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
        />
        <button
          onClick={() => {
            onSetPin(val.trim());
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
          className="px-4 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400"
        >
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}
