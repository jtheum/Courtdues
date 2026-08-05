import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";

// Each group is its own board, chosen by the ?g= slug in the URL.
// courtdues.com -> "main"; courtdues.com/?g=eastside -> "eastside".
const SLUG = (new URLSearchParams(window.location.search).get("g") || "main")
  .toLowerCase()
  .trim();
const slugify = (s) =>
  (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "group";
const groupUrl = (slug) =>
  slug === "main" ? window.location.origin + "/" : window.location.origin + "/?g=" + slug;

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

// Flat charge per player. Set from the board's rate at render time (default $10),
// with an optional per-session override via s.rate. Does NOT change with headcount.
let BOARD_RATE = 10;
const attCount = (s) => (s.attendees || []).length;
const perPlayer = (s) => (s.rate != null ? num(s.rate) : BOARD_RATE);
// What the court actually cost you that night (your outlay).
const sessionTotal = (s) => {
  if (s.totalCost != null) return num(s.totalCost);
  return num(s.cost) * attCount(s);
};

const empty = { players: [], sessions: [], payments: [], courts: [], pin: "", name: "" };

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
  const [mode, setMode] = useState("view"); // view | manage | login
  const [session, setSession] = useState(null);
  const [isManager, setIsManager] = useState(false);
  const [boardUnclaimed, setBoardUnclaimed] = useState(false);
  const [tab, setTab] = useState("roster"); // roster | sessions | courts | settings
  const [viewTab, setViewTab] = useState("sessions"); // sessions | upcoming
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

  // ---- auth: track session + whether the user manages THIS board ----
  const refreshManagerStatus = async (sess) => {
    if (!sess) {
      setIsManager(false);
      // Is this board unclaimed (no manager yet)? Controls the "Claim" option.
      const { data: unclaimed } = await supabase.rpc("board_is_unclaimed", { p_slug: SLUG });
      setBoardUnclaimed(!!unclaimed);
      return;
    }
    const { data: mine } = await supabase
      .from("board_managers")
      .select("user_id")
      .eq("board_slug", SLUG)
      .eq("user_id", sess.user.id)
      .maybeSingle();
    setIsManager(!!mine);
    if (!mine) {
      const { data: unclaimed } = await supabase.rpc("board_is_unclaimed", { p_slug: SLUG });
      setBoardUnclaimed(!!unclaimed);
    } else {
      setBoardUnclaimed(false);
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      refreshManagerStatus(s);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      refreshManagerStatus(s);
      if (!s && mode === "manage") setMode("view"); // signed out while managing
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const claimBoard = async () => {
    if (!session) return;
    const { error } = await supabase
      .from("board_managers")
      .insert({ board_slug: SLUG, user_id: session.user.id });
    if (!error) {
      setIsManager(true);
      setBoardUnclaimed(false);
      setMode("manage");
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setIsManager(false);
    setMode("view");
    refreshManagerStatus(null);
  };

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

  // Flat per-player rate for this board (default $10). Set before any perPlayer call.
  BOARD_RATE = data && data.rate != null ? num(data.rate) : 10;

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
    const courtCosts = data.sessions.reduce((s, sess) => s + sessionTotal(sess), 0);
    return {
      rows,
      collected,
      billed,
      outstanding: billed - collected,
      courtCosts,
      extra: collected - courtCosts, // cash in hand beyond what courts cost you
    };
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
  const toggleRegular = (id) =>
    persist({
      ...data,
      players: data.players.map((p) => (p.id === id ? { ...p, regular: !p.regular } : p)),
    });
  const addSession = (s) =>
    persist({ ...data, sessions: [...data.sessions, { id: uid(), ...s }] });
  const updateSession = (id, patch) =>
    persist({
      ...data,
      sessions: data.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  const removeSession = (id) =>
    persist({ ...data, sessions: data.sessions.filter((s) => s.id !== id) });

  // Attendance is the one thing viewers (not signed in) may change. It uses a
  // plain UPDATE (not upsert) so anonymous writers are allowed by the DB guard,
  // which permits attendance-only changes and blocks any money edits.
  const toggleAttendee = async (sessionId, playerId) => {
    const next = {
      ...data,
      sessions: data.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              attendees: (s.attendees || []).includes(playerId)
                ? (s.attendees || []).filter((x) => x !== playerId)
                : [...(s.attendees || []), playerId],
            }
          : s
      ),
    };
    setData(next); // optimistic
    try {
      const { error } = await supabase
        .from("boards")
        .update({ data: next, updated_at: new Date().toISOString() })
        .eq("slug", SLUG);
      if (error) throw error;
      setSaveErr("");
    } catch (e) {
      setSaveErr("Couldn't update attendance — someone may have just changed something. Try again.");
    }
  };
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

  const setGroupName = (name) => persist({ ...data, name });
  const setRate = (r) => persist({ ...data, rate: Math.max(0, num(r)) });

  const displayName = data.name || (SLUG === "main" ? "Main" : SLUG);

  // Create a blank group. If claimForSelf is true, you become its manager.
  // If false, it's left unclaimed so another person can sign in and claim it.
  const createGroup = async (name, claimForSelf = true) => {
    if (!session) return { error: "Please sign in first." };
    let base = slugify(name);
    let slug = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data: existing } = await supabase
        .from("boards")
        .select("slug")
        .eq("slug", slug)
        .maybeSingle();
      if (!existing) break;
      n += 1;
      slug = `${base}-${n}`;
    }
    const blank = {
      players: [],
      sessions: [],
      payments: [],
      courts: DEFAULT_COURTS.map((cn) => ({ id: uid(), name: cn, cost: 0 })),
      name: (name || "").trim() || slug,
      seeded: true,
    };
    const { error } = await supabase.from("boards").insert({ slug, data: blank });
    if (error) return { error: "Couldn't create the group. Try a different name." };
    if (claimForSelf) {
      const { error: mErr } = await supabase
        .from("board_managers")
        .insert({ board_slug: slug, user_id: session.user.id });
      if (mErr)
        return { error: "Group created, but claiming it failed. Open its link and Claim it." };
    }
    return { slug, name: blank.name, link: groupUrl(slug), claimed: claimForSelf };
  };

  // Only the groups the signed-in manager owns.
  const listGroups = async () => {
    if (!session) return [];
    const { data: rows } = await supabase
      .from("board_managers")
      .select("board_slug, boards(slug, data)")
      .eq("user_id", session.user.id);
    return (rows || [])
      .map((r) => {
        const b = r.boards || {};
        return {
          slug: r.board_slug,
          name: (b.data && b.data.name) || (r.board_slug === "main" ? "Main" : r.board_slug),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const enterManage = () => {
    if (isManager) setMode("manage");
    else setMode("login"); // login screen handles: sign in, or claim, or "not yours"
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
              {displayName}
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
        {mode === "login" && (
          <AuthGate
            session={session}
            isManager={isManager}
            boardUnclaimed={boardUnclaimed}
            groupName={displayName}
            onClaim={claimBoard}
            onSignOut={signOut}
            onManage={() => setMode("manage")}
            onCancel={() => setMode("view")}
          />
        )}

        {/* ===== VIEW MODE ===== */}
        {mode === "view" && (
          <>
            <InstallPrompt />
            <div className="mt-5 flex gap-1 rounded-xl bg-stone-900 p-1 text-sm">
              {[
                ["sessions", "Sessions"],
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

            {viewTab === "sessions" && (
              <>
                <NextGameCard game={nextGame} sessionCount={data.sessions.length} />
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Stat label="Collected" value={money(totals.collected)} tone="emerald" />
                  <Stat label="Left" value={money(totals.outstanding)} tone="orange" />
                  <Stat
                    label="Extra"
                    value={money(totals.extra)}
                    tone={totals.extra >= 0 ? "sky" : "orange"}
                  />
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <h2 className="text-xs uppercase tracking-widest text-stone-500">
                    Who owes what
                  </h2>
                  <button
                    onClick={copyStandings}
                    className="text-xs font-semibold text-orange-400 hover:text-orange-300"
                  >
                    {copied ? "Copied ✓" : "Copy for group chat"}
                  </button>
                </div>
                <div className="mt-3">
                  <SessionsBreakdown
                    sessions={data.sessions}
                    players={data.players}
                    payments={data.payments}
                    onToggleAttendee={toggleAttendee}
                  />
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
                onToggleRegular={toggleRegular}
                fronted={totals.billed}
                collected={totals.collected}
              />
            )}
            {tab === "sessions" && (
              <SessionsManager
                players={data.players}
                courts={data.courts}
                sessions={[...data.sessions].sort(
                  (a, b) =>
                    (a.date || "").localeCompare(b.date || "") ||
                    (a.time || "").localeCompare(b.time || "")
                )}
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
            {tab === "settings" && (
              <SettingsPanel
                slug={SLUG}
                groupName={displayName}
                onSetGroupName={setGroupName}
                rate={data.rate != null ? data.rate : 10}
                onSetRate={setRate}
                onCreateGroup={createGroup}
                onListGroups={listGroups}
                email={session && session.user && session.user.email}
                onSignOut={signOut}
              />
            )}
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

function NextGameCard({ game, sessionCount = 0 }) {
  if (!game)
    return (
      <div className="mt-5 rounded-2xl border border-dashed border-stone-800 bg-stone-900/40 p-5 text-center">
        <p className="text-sm text-stone-400">No game scheduled yet.</p>
      </div>
    );
  const share = perPlayer(game);
  const fullRun = share * sessionCount;
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
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-baseline gap-1 rounded-lg bg-stone-950/60 px-3 py-1.5">
          <span className="font-mono text-lg font-bold text-orange-400">{money(share)}</span>
          <span className="text-xs text-stone-500">/ player</span>
        </div>
        {sessionCount > 0 && (
          <div className="text-[11px] text-stone-500">
            × {sessionCount} session{sessionCount === 1 ? "" : "s"} ={" "}
            <span className="font-mono text-stone-300">{money(fullRun)}</span> full run
          </div>
        )}
      </div>
      <div className="mt-1.5 text-[11px] text-stone-500">
        {attCount(game)} player{attCount(game) === 1 ? "" : "s"} in for this one
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "sky"
      ? "text-sky-400"
      : "text-orange-400";
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900 p-3">
      <div className="text-[11px] uppercase tracking-widest text-stone-500">{label}</div>
      <div className={`mt-1 font-mono text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}

function StandingRow({ r, open, onToggle }) {
  const pct = r.owed > 0 ? Math.min(100, (r.paid / r.owed) * 100) : r.paid > 0 ? 100 : 0;
  const square = Math.abs(r.balance) < 0.001;
  const credit = r.balance < -0.001;
  return (
    <button
      onClick={onToggle}
      className="w-full text-left rounded-xl border border-stone-800 bg-stone-900 p-3 hover:border-stone-700 transition-colors"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold flex items-center gap-1.5">
          {r.name}
          <span className="text-stone-600 text-[10px]">{open ? "▲" : "▾"}</span>
        </span>
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
    </button>
  );
}

function StandingsList({ rows, sessions, payments }) {
  const [open, setOpen] = useState(null);
  return (
    <>
      {rows.map((r) => (
        <div key={r.id}>
          <StandingRow
            r={r}
            open={open === r.id}
            onToggle={() => setOpen(open === r.id ? null : r.id)}
          />
          {open === r.id && <PlayerDetail player={r} sessions={sessions} payments={payments} />}
        </div>
      ))}
    </>
  );
}

// Per-session breakdown for one player. Payments aren't tagged to a session,
// so we apply each player's payments to their OLDEST sessions first to show
// which nights are covered.
function PlayerDetail({ player, sessions, payments }) {
  const paidTotal = payments
    .filter((p) => p.playerId === player.id)
    .reduce((s, p) => s + num(p.amount), 0);
  const attended = sessions
    .filter((s) => (s.attendees || []).includes(player.id))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  let pool = paidTotal;
  const lines = attended.map((s) => {
    const share = perPlayer(s);
    const covered = Math.min(Math.max(0, pool), share);
    pool -= covered;
    return { s, share, due: share - covered };
  });
  const owed = lines.reduce((a, l) => a + l.share, 0);
  const balance = owed - paidTotal;
  const creditLeft = Math.max(0, paidTotal - owed);

  return (
    <div className="mt-2 rounded-xl border border-stone-800 bg-stone-950/40 p-3">
      <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-2">Per session</div>
      {lines.length === 0 ? (
        <p className="text-xs text-stone-500">Not in any sessions yet.</p>
      ) : (
        <div>
          {[...lines].reverse().map((l, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-1.5 border-b border-stone-800/60 last:border-0"
            >
              <div className="min-w-0">
                <div className="text-sm text-stone-300">{prettyDate(l.s.date)}</div>
                {l.s.place && (
                  <div className="text-[11px] text-stone-500 truncate">{l.s.place}</div>
                )}
              </div>
              <div className="text-right">
                <div className="font-mono text-sm text-stone-300">{money(l.share)}</div>
                <div className={`text-[11px] ${l.due < 0.001 ? "text-emerald-400" : "text-orange-400"}`}>
                  {l.due < 0.001 ? "paid ✓" : `${money(l.due)} due`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 pt-2 border-t border-stone-800 flex items-center justify-between text-sm">
        <span className="text-stone-400">
          paid {money(paidTotal)} of {money(owed)}
        </span>
        <span
          className={`font-mono font-bold ${
            Math.abs(balance) < 0.001
              ? "text-emerald-400"
              : balance < 0
              ? "text-sky-400"
              : "text-orange-400"
          }`}
        >
          {Math.abs(balance) < 0.001
            ? "square"
            : balance < 0
            ? `credit ${money(-balance)}`
            : `${money(balance)} due`}
        </span>
      </div>
      {creditLeft > 0.001 && (
        <div className="text-[11px] text-sky-400 mt-1">
          {money(creditLeft)} prepaid credit remaining
        </div>
      )}
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

// For each player, apply their payments to their OLDEST sessions first, so each
// session knows how much that player still owes for that specific night.
function computeCoverage(players, sessions, payments) {
  const cov = {};
  players.forEach((p) => {
    const paid = payments
      .filter((x) => x.playerId === p.id)
      .reduce((a, b) => a + num(b.amount), 0);
    const attended = sessions
      .filter((s) => (s.attendees || []).includes(p.id))
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    let pool = paid;
    const bySession = {};
    attended.forEach((s) => {
      const share = perPlayer(s);
      const covered = Math.min(Math.max(0, pool), share);
      pool -= covered;
      bySession[s.id] = share - covered;
    });
    cov[p.id] = { bySession, paid };
  });
  return cov;
}

function SessionsBreakdown({ sessions, players, payments, onToggleAttendee }) {
  const [open, setOpen] = useState(null);
  const coverage = useMemo(
    () => computeCoverage(players, sessions, payments),
    [players, sessions, payments]
  );
  const pmap = Object.fromEntries(players.map((p) => [p.id, p.name]));
  const sorted = [...sessions].sort(
    (a, b) =>
      (a.date || "").localeCompare(b.date || "") || (a.time || "").localeCompare(b.time || "")
  );

  if (sorted.length === 0) return <EmptyNote text="No sessions logged yet." />;

  return (
    <div className="space-y-2">
      {sorted.map((s) => {
        const att = (s.attendees || []).filter((pid) => pmap[pid]);
        const share = perPlayer(s);
        const isUpcoming = !!(s.date && s.date >= todayISO());
        const dueFor = (pid) => {
          const cov = coverage[pid];
          return cov && cov.bySession[s.id] != null ? cov.bySession[s.id] : share;
        };
        const dueTotal = att.reduce((sum, pid) => sum + dueFor(pid), 0);
        const isOpen = open === s.id;
        return (
          <div key={s.id} className="rounded-xl border border-stone-800 bg-stone-900">
            <button
              onClick={() => setOpen(isOpen ? null : s.id)}
              className="w-full text-left p-3 flex items-center justify-between"
            >
              <div className="min-w-0">
                <div className="font-semibold text-sm flex items-center gap-1.5">
                  {prettyDate(s.date)}
                  <span className="text-stone-600 text-[10px]">{isOpen ? "▲" : "▾"}</span>
                </div>
                <div className="text-[11px] text-stone-500 truncate">
                  {s.place || "No place"} · {money(share)}/player · {att.length} in
                </div>
              </div>
              <div className="text-right shrink-0">
                {att.length > 0 && dueTotal < 0.001 ? (
                  <span className="text-xs font-semibold text-emerald-400">all paid ✓</span>
                ) : isUpcoming ? (
                  att.length > 0 ? (
                    <span className="text-[11px] text-stone-500">upcoming</span>
                  ) : null
                ) : dueTotal > 0.001 ? (
                  <span className="font-mono text-sm font-bold text-orange-400">
                    {money(dueTotal)} due
                  </span>
                ) : null}
              </div>
            </button>

            {isOpen && (
              <div className="px-3 pb-3">
                <div className="border-t border-stone-800 pt-2">
                  <div className="text-[11px] text-stone-500 mb-1">
                    Tap your name to check in or out.
                  </div>
                  {players.length === 0 ? (
                    <p className="text-xs text-stone-500">No players yet.</p>
                  ) : (
                    players.map((p) => {
                      const inSession = (s.attendees || []).includes(p.id);
                      const due = dueFor(p.id);
                      const paid = due < 0.001;
                      return (
                        <button
                          key={p.id}
                          onClick={() => onToggleAttendee(s.id, p.id)}
                          className="w-full flex items-center justify-between py-1.5 text-sm"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <span
                              className={`flex items-center justify-center h-4 w-4 rounded-full border text-[9px] shrink-0 ${
                                inSession
                                  ? "bg-orange-500 border-orange-500 text-stone-950"
                                  : "border-stone-600 text-transparent"
                              }`}
                            >
                              ✓
                            </span>
                            <span className={inSession ? "text-stone-200" : "text-stone-500"}>
                              {p.name}
                            </span>
                          </span>
                          {inSession && (
                            <span className="flex items-baseline gap-2 shrink-0">
                              <span className="font-mono text-stone-400">{money(share)}</span>
                              {paid ? (
                                <span className="text-[11px] font-semibold text-emerald-400">
                                  paid ✓
                                </span>
                              ) : !isUpcoming ? (
                                <span className="text-[11px] font-semibold text-orange-400">
                                  {money(due)} due
                                </span>
                              ) : null}
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

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

function RosterManager({ rows, onAdd, onRemove, onPay, onToggleRegular, fronted, collected }) {
  const [name, setName] = useState("");
  const [payFor, setPayFor] = useState(null); // { id, mode: 'pay' | 'refund' }
  const [payAmt, setPayAmt] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);

  const owedToYou = rows.reduce((s, r) => s + Math.max(0, r.balance), 0);
  const toRefund = rows.reduce((s, r) => s + Math.max(0, -r.balance), 0);

  const openPanel = (id, mode, prefill) => {
    setPayFor(payFor && payFor.id === id && payFor.mode === mode ? null : { id, mode });
    setPayAmt(prefill != null ? String(prefill) : "");
  };

  return (
    <div className="mt-4">
      {/* Your ledger */}
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-3 mb-3">
        <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-2">Your ledger</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-stone-400">Fronted</span>
            <span className="font-mono text-stone-200">{money(fronted)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-stone-400">Collected</span>
            <span className="font-mono text-stone-200">{money(collected)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-stone-400">Owed to you</span>
            <span className="font-mono text-orange-400">{money(owedToYou)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-stone-400">To refund</span>
            <span className="font-mono text-sky-400">{money(toRefund)}</span>
          </div>
        </div>
      </div>

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
        {rows.map((r) => {
          const credit = r.balance < -0.001;
          const owes = r.balance > 0.001;
          return (
            <div key={r.id} className="rounded-xl border border-stone-800 bg-stone-900 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate">{r.name}</span>
                    <button
                      onClick={() => onToggleRegular(r.id)}
                      className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                        r.regular
                          ? "bg-orange-500 text-stone-950"
                          : "bg-stone-800 text-stone-500 hover:text-stone-300"
                      }`}
                      title="Regulars are auto-added to every new session"
                    >
                      {r.regular ? "★ Regular" : "Regular?"}
                    </button>
                  </div>
                  <div className="text-[11px] text-stone-500 font-mono">
                    paid {money(r.paid)} ·{" "}
                    {credit ? (
                      <span className="text-sky-400">credit {money(-r.balance)}</span>
                    ) : owes ? (
                      <span className="text-orange-400">owes {money(r.balance)}</span>
                    ) : (
                      <span className="text-emerald-400">square</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setConfirmDel(confirmDel === r.id ? null : r.id)}
                  className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg bg-stone-800 text-stone-400 hover:bg-rose-900/40 hover:text-rose-300"
                  aria-label={`Remove ${r.name}`}
                >
                  ✕
                </button>
              </div>

              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => openPanel(r.id, "pay", owes ? Math.round(r.balance * 100) / 100 : "")}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
                >
                  Log payment
                </button>
                <button
                  onClick={() => openPanel(r.id, "refund", credit ? Math.round(-r.balance * 100) / 100 : "")}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-sky-600/20 text-sky-300 hover:bg-sky-600/30"
                >
                  Refund
                </button>
              </div>

              {payFor && payFor.id === r.id && (
                <div className="mt-3 flex gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    value={payAmt}
                    onChange={(e) => setPayAmt(e.target.value)}
                    placeholder={payFor.mode === "refund" ? "Refund amount" : "Payment amount"}
                    className={`flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none ${
                      payFor.mode === "refund" ? "focus:border-sky-500" : "focus:border-emerald-500"
                    }`}
                  />
                  <button
                    onClick={() => {
                      const amt = num(payAmt);
                      if (amt > 0) onPay(r.id, payFor.mode === "refund" ? -amt : amt);
                      setPayFor(null);
                      setPayAmt("");
                    }}
                    className={`px-4 rounded-lg text-stone-950 text-sm font-semibold ${
                      payFor.mode === "refund"
                        ? "bg-sky-500 hover:bg-sky-400"
                        : "bg-emerald-500 hover:bg-emerald-400"
                    }`}
                  >
                    {payFor.mode === "refund" ? "Refund" : "Save"}
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
          );
        })}
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
  const [attendees, setAttendees] = useState(() =>
    players.filter((p) => p.regular).map((p) => p.id)
  );
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

  const rate = BOARD_RATE;
  const collectAtRate = rate * attendees.length;
  const sessionExtra = collectAtRate - num(totalCost);

  const save = () => {
    if (!date || num(totalCost) <= 0) return;
    onAdd({ date, time, endTime, place: place.trim(), totalCost: num(totalCost), attendees });
    setPlace("");
    setTotalCost("");
    setCourtId(null);
    setOther(false);
    setAttendees(players.filter((p) => p.regular).map((p) => p.id));
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
                    {p.regular ? "★ " : ""}
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {attendees.length > 0 && (
          <div className="mt-3 text-xs text-stone-400">
            <span className="font-mono font-bold text-orange-400">{money(rate)}</span>/player ×{" "}
            {attendees.length} = <span className="font-mono">{money(collectAtRate)}</span>
            {num(totalCost) > 0 && (
              <>
                {" · court "}
                {money(num(totalCost))}
                {" · extra "}
                <span
                  className={`font-mono ${sessionExtra >= 0 ? "text-sky-400" : "text-orange-400"}`}
                >
                  {money(sessionExtra)}
                </span>
              </>
            )}
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

function AuthGate({ session, isManager, boardUnclaimed, groupName, onClaim, onSignOut, onManage, onCancel }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  const sendLink = async () => {
    if (!email.trim()) return;
    setSending(true);
    setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.href },
    });
    setSending(false);
    if (error) setErr(error.message || "Couldn't send the link.");
    else setSent(true);
  };

  return (
    <div className="mt-6 rounded-2xl border border-stone-800 bg-stone-900 p-5">
      {!session ? (
        sent ? (
          <>
            <div className="text-sm font-semibold text-emerald-300">Check your email</div>
            <p className="mt-1 text-xs text-stone-400">
              We sent a sign-in link to {email}. Open it on this device to finish signing in.
            </p>
            <button onClick={onCancel} className="text-xs text-stone-500 mt-3 hover:text-stone-300">
              Back
            </button>
          </>
        ) : (
          <>
            <div className="text-sm font-semibold text-stone-200">Manager sign in</div>
            <p className="mt-1 text-xs text-stone-400 mb-3">
              Enter your email and we'll send a one-tap sign-in link. Viewers don't need this.
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendLink()}
                placeholder="you@email.com"
                className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
              <button
                onClick={sendLink}
                disabled={sending || !email.trim()}
                className="px-4 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400 disabled:opacity-40"
              >
                {sending ? "Sending…" : "Send link"}
              </button>
            </div>
            {err && <p className="text-xs text-rose-400 mt-2">{err}</p>}
            <button onClick={onCancel} className="text-xs text-stone-500 mt-3 hover:text-stone-300">
              Cancel
            </button>
          </>
        )
      ) : isManager ? (
        <>
          <div className="text-sm text-stone-200">
            You manage <b className="text-stone-100">{groupName}</b>.
          </div>
          <button
            onClick={onManage}
            className="mt-3 w-full rounded-lg bg-orange-500 text-stone-950 py-2.5 text-sm font-bold hover:bg-orange-400"
          >
            Manage this group
          </button>
          <button onClick={onSignOut} className="text-xs text-stone-500 mt-3 hover:text-stone-300">
            Sign out
          </button>
        </>
      ) : boardUnclaimed ? (
        <>
          <div className="text-sm text-stone-200">
            No one manages <b className="text-stone-100">{groupName}</b> yet.
          </div>
          <p className="mt-1 text-xs text-stone-400">
            Claim it to become its manager. Only do this for a group that's yours.
          </p>
          <button
            onClick={onClaim}
            className="mt-3 w-full rounded-lg bg-orange-500 text-stone-950 py-2.5 text-sm font-bold hover:bg-orange-400"
          >
            Claim this group
          </button>
          <button onClick={onSignOut} className="text-xs text-stone-500 mt-3 hover:text-stone-300">
            Sign out
          </button>
        </>
      ) : (
        <>
          <div className="text-sm text-stone-200">This group is managed by someone else.</div>
          <p className="mt-1 text-xs text-stone-400">
            You can view it, but only its manager can edit. If it's yours, sign in with the email
            that manages it.
          </p>
          <button
            onClick={onCancel}
            className="mt-3 w-full rounded-lg bg-stone-800 text-stone-200 py-2.5 text-sm font-semibold hover:bg-stone-700"
          >
            Back to standings
          </button>
          <button onClick={onSignOut} className="text-xs text-stone-500 mt-3 hover:text-stone-300">
            Sign out
          </button>
        </>
      )}
    </div>
  );
}

function SettingsPanel({ slug, groupName, onSetGroupName, rate, onSetRate, onCreateGroup, onListGroups, email, onSignOut }) {
  const [nameVal, setNameVal] = useState(groupName || "");
  const [nameSaved, setNameSaved] = useState(false);
  const [rateVal, setRateVal] = useState(String(rate));
  const [rateSaved, setRateSaved] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [newName, setNewName] = useState("");
  const [claimSelf, setClaimSelf] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [created, setCreated] = useState(null); // { name, link, claimed }
  const [createdCopied, setCreatedCopied] = useState(false);

  const [groups, setGroups] = useState(null);
  const link = groupUrl(slug);

  useEffect(() => {
    let live = true;
    onListGroups().then((g) => live && setGroups(g));
    return () => {
      live = false;
    };
  }, []);

  const copyLink = () => {
    navigator.clipboard?.writeText(link).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    });
  };

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateErr("");
    const res = await onCreateGroup(newName, claimSelf);
    setCreating(false);
    if (res && res.error) {
      setCreateErr(res.error);
      return;
    }
    setCreated({ name: res.name, link: res.link, claimed: res.claimed });
    setNewName("");
  };

  const copyCreated = () => {
    if (!created) return;
    navigator.clipboard?.writeText(created.link).then(() => {
      setCreatedCopied(true);
      setTimeout(() => setCreatedCopied(false), 1500);
    });
  };

  return (
    <div className="mt-4 space-y-4">
      {/* This group */}
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-4">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-2">This group</div>
        <label className="text-[11px] uppercase tracking-widest text-stone-500">Group name</label>
        <div className="mt-1 flex gap-2">
          <input
            value={nameVal}
            onChange={(e) => setNameVal(e.target.value)}
            placeholder="e.g. Sunday Run"
            className="flex-1 rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
          <button
            onClick={() => {
              onSetGroupName(nameVal.trim());
              setNameSaved(true);
              setTimeout(() => setNameSaved(false), 1500);
            }}
            className="px-4 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400"
          >
            {nameSaved ? "Saved ✓" : "Save"}
          </button>
        </div>
        <div className="mt-3">
          <label className="text-[11px] uppercase tracking-widest text-stone-500">Share link</label>
          <div className="mt-1 flex gap-2">
            <div className="flex-1 truncate rounded-lg bg-stone-950/60 border border-stone-800 px-3 py-2 text-xs text-stone-400">
              {link}
            </div>
            <button
              onClick={copyLink}
              className="px-4 rounded-lg bg-stone-800 text-stone-200 text-sm font-semibold hover:bg-stone-700"
            >
              {linkCopied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">Send this to this group's players.</p>
        </div>
        <div className="mt-3">
          <label className="text-[11px] uppercase tracking-widest text-stone-500">
            Charge per player
          </label>
          <div className="mt-1 flex gap-2">
            <div className="flex items-center rounded-lg bg-stone-800 border border-stone-700 px-3 flex-1">
              <span className="text-stone-500 text-sm">$</span>
              <input
                type="number"
                inputMode="decimal"
                value={rateVal}
                onChange={(e) => setRateVal(e.target.value)}
                className="w-full bg-transparent py-2 pl-1 text-sm outline-none"
              />
            </div>
            <button
              onClick={() => {
                onSetRate(rateVal);
                setRateSaved(true);
                setTimeout(() => setRateSaved(false), 1500);
              }}
              className="px-4 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400"
            >
              {rateSaved ? "Saved ✓" : "Save"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-stone-500">
            Flat amount each player owes per session, no matter how many show up.
          </p>
        </div>
      </div>

      {/* Create a new group */}
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-4">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-2">New group</div>

        {created ? (
          <div>
            <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 p-3">
              <div className="text-sm font-semibold text-emerald-300">
                Created "{created.name}" ✓
              </div>
              <div className="mt-2 text-[11px] uppercase tracking-widest text-stone-500">
                Share link
              </div>
              <div className="mt-1 flex gap-2">
                <div className="flex-1 truncate rounded-lg bg-stone-950/60 border border-stone-800 px-3 py-2 text-xs text-stone-300">
                  {created.link}
                </div>
                <button
                  onClick={copyCreated}
                  className="px-4 rounded-lg bg-orange-500 text-stone-950 text-sm font-semibold hover:bg-orange-400"
                >
                  {createdCopied ? "Copied ✓" : "Copy"}
                </button>
              </div>
              {created.claimed ? (
                <div className="mt-2 text-[11px] text-stone-400">
                  You manage this group. Send the link to its players so they can view standings.
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-stone-400">
                  Left unclaimed for another manager. Send them this link — they tap{" "}
                  <b className="text-stone-200">Manage</b>, sign in with their email, and{" "}
                  <b className="text-stone-200">Claim this group</b>. It's then theirs alone.
                </div>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              {created.claimed && (
                <button
                  onClick={() => {
                    window.location.search = created.link.includes("?g=")
                      ? "?g=" + created.link.split("?g=")[1]
                      : "";
                  }}
                  className="flex-1 rounded-lg bg-stone-800 text-stone-200 py-2 text-sm font-semibold hover:bg-stone-700"
                >
                  Open group
                </button>
              )}
              <button
                onClick={() => setCreated(null)}
                className="flex-1 rounded-lg border border-stone-700 text-stone-300 py-2 text-sm font-semibold hover:bg-stone-800"
              >
                Create another
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-stone-400 mb-3">
              Starts a fresh, blank board with its own roster, sessions, and share link.
            </p>
            <div className="space-y-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Group name (e.g. Eastside)"
                className="w-full rounded-lg bg-stone-800 border border-stone-700 px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
              <div>
                <div className="text-[11px] uppercase tracking-widest text-stone-500 mb-1">
                  Who manages it?
                </div>
                <div className="flex gap-1 rounded-lg bg-stone-800 p-1 text-xs">
                  <button
                    onClick={() => setClaimSelf(true)}
                    className={`flex-1 rounded-md py-1.5 font-semibold ${
                      claimSelf ? "bg-orange-500 text-stone-950" : "text-stone-400"
                    }`}
                  >
                    Me
                  </button>
                  <button
                    onClick={() => setClaimSelf(false)}
                    className={`flex-1 rounded-md py-1.5 font-semibold ${
                      !claimSelf ? "bg-orange-500 text-stone-950" : "text-stone-400"
                    }`}
                  >
                    Another person
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-stone-500">
                  {claimSelf
                    ? "You'll own it and can edit right away."
                    : "Left unclaimed — send the link and they claim it after signing in."}
                </p>
              </div>
              <button
                onClick={create}
                disabled={!newName.trim() || creating}
                className="w-full rounded-lg bg-orange-500 text-stone-950 py-2.5 text-sm font-bold hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? "Creating…" : "Create group"}
              </button>
              {createErr && <p className="text-xs text-rose-400">{createErr}</p>}
            </div>
          </>
        )}
      </div>

      {/* Switch group */}
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-4">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-2">Switch group</div>
        {groups === null ? (
          <p className="text-xs text-stone-500">Loading your groups…</p>
        ) : groups.length <= 1 ? (
          <p className="text-xs text-stone-500">You only have one group so far.</p>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => {
              const current = g.slug === slug;
              return (
                <button
                  key={g.slug}
                  disabled={current}
                  onClick={() => {
                    window.location.search = g.slug === "main" ? "" : "?g=" + g.slug;
                  }}
                  className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                    current
                      ? "border-orange-500/40 bg-stone-950/40 text-stone-400 cursor-default"
                      : "border-stone-700 bg-stone-800 text-stone-200 hover:bg-stone-700"
                  }`}
                >
                  <span className="font-semibold">{g.name}</span>
                  <span className="text-[11px] text-stone-500">{current ? "current" : "open →"}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] text-stone-500">
          Shows only the groups you manage. Managing another still uses your same sign-in.
        </p>
      </div>

      {/* Account */}
      <div className="rounded-xl border border-stone-800 bg-stone-900 p-4">
        <div className="text-xs uppercase tracking-widest text-stone-500 mb-2">Account</div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-stone-400 truncate">
            Signed in as <span className="text-stone-200">{email || "—"}</span>
          </div>
          <button
            onClick={onSignOut}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-stone-800 text-stone-200 hover:bg-stone-700"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
