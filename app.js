/* NY League draft assistant — UI + state. */
(function () {
  "use strict";
  const E = window.Engine;
  const L = E.LEAGUE;
  const KEY = "ny-league-draft-v4";   // v4: player ids are file-stable, old rank-based saves are invalid
  const CFG_KEY = "ny-league-config-v1";
  const FACTORY = E.getConfig();           // pristine NY defaults, captured before any stored config applies
  const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DST"];

  let state = { picks: [], custom: [], replay: false, viewSeat: null };
  let players = [];
  let ui = { pos: "ALL", q: "", showGone: false, sort: "rank", dir: 1 };
  let botSeed = null;   // set by tests so a simulated draft is reproducible
  let cache = { key: null };

  /* ---------------- persistence ---------------- */
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) E.configure(JSON.parse(raw));
    } catch (e) {}
  }
  function saveConfig() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(E.getConfig())); } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.picks)) {
        state.picks = s.picks;
        state.custom = Array.isArray(s.custom) ? s.custom : [];
        state.replay = !!s.replay;
        state.viewSeat = s.viewSeat || null;
      }
    } catch (e) {}
  }

  /* ---------------- pool ---------------- */
  function rebuild() {
    players = E.buildPlayers();
    const posCount = {};
    for (const p of players) posCount[p.pos] = (posCount[p.pos] || 0) + 1;
    state.custom.forEach(function (c, i) {
      posCount[c.pos] = (posCount[c.pos] || 0) + 1;
      const posRank = posCount[c.pos];
      const proj = E.curveValue(c.pos, posRank);
      const vor = proj - E.curveValue(c.pos, E.REPLACEMENT_RANK[c.pos]);
      players.push({
        id: 900 + i, rank: 900 + i, name: c.name, pos: c.pos, team: c.team,
        tier: c.pos === "K" ? 11 : (c.pos === "DST" ? 10 : 9),
        note: "Added by you during the draft.", flags: [], custom: true,
        bye: E.BYES[c.team] || 0, posRank,
        proj: Math.round(proj * 10) / 10,
        vor: Math.round(vor * 10) / 10,
        vorAdj: Math.round(vor * E.POS_ADJ[c.pos] * 10) / 10
      });
    });
    // drop picks that point at players no longer in the pool
    const ids = new Set(players.map(function (p) { return p.id; }));
    state.picks = state.picks.filter(function (pk) {
      return pk.playerId === null || ids.has(pk.playerId);
    });
  }

  const byId = function (id) { return players.find(function (p) { return p.id === id; }); };
  const takenIds = function () {
    const s = new Set();
    for (const pk of state.picks) if (pk.playerId !== null) s.add(pk.playerId);
    return s;
  };
  const seatPlayers = function (seat) {
    return state.picks.filter(function (pk) { return pk.seat === seat; })
                      .map(function (pk) { return byId(pk.playerId); })
                      .filter(Boolean);
  };

  /* ---------------- draft context ----------------
     Person-agnostic: everything is computed for whichever seat is on the
     clock. picksLeft/gap describe THAT team's remaining draft. */
  function ctx() {
    const overall = state.picks.length + 1;
    const over = overall > L.totalPicks;
    const onClock = over ? null : E.seatForPick(overall);
    let picksLeft = 0, gap = 0;
    if (!over) {
      const all = E.myPicks(onClock);
      const idx = all.indexOf(overall);          // the current pick is theirs by construction
      picksLeft = all.length - idx;
      gap = idx + 1 < all.length ? all[idx + 1] - overall : 0;
    }
    return {
      overall, over, onClock,
      round: over ? L.rounds : E.roundForPick(overall),
      inRound: over ? L.teams : overall - (E.roundForPick(overall) - 1) * L.teams,
      picksLeft, gap
    };
  }

  function analysis() {
    const key = state.picks.length + "|" + state.custom.length;
    if (cache.key === key) return cache.val;
    const c = ctx();
    const team = c.over ? [] : seatPlayers(c.onClock);
    const rec = E.recommend(
      { players, takenIds: takenIds(), myPlayers: team, picksLeft: c.picksLeft, gap: c.gap },
      { seed: 20260823, sims: 400, taken: takenIds().size }
    );
    const val = { c, rec, team };
    cache = { key, val };
    return val;
  }

  /* ---------------- actions ---------------- */
  function draft(id) {
    const c = ctx();
    if (c.over) return false;
    if (takenIds().has(id)) return false;
    if (!byId(id)) return false;
    state.picks.push({ overall: c.overall, seat: c.onClock, playerId: id });
    cache.key = null; save(); render();
    return true;
  }
  function undo() {
    if (!state.picks.length) return;
    state.picks.pop(); cache.key = null; save(); render();
  }
  function autoOne() {
    const c = ctx();
    if (c.over) return false;
    const p = E.autoPick({
      players, takenIds: takenIds(),
      teamPlayers: seatPlayers(c.onClock), picksLeft: c.picksLeft
    }, botSeed === null ? {} : { seed: botSeed * 7919 + c.overall });
    // A null here means the pool is dry for every legal position — log a
    // placeholder so the clock and the round counter stay correct.
    state.picks.push({ overall: c.overall, seat: c.onClock, playerId: p ? p.id : null });
    return true;
  }
  function simAll() {
    let g = 0;
    while (g++ < L.totalPicks + 5) { if (!autoOne()) break; }
    cache.key = null; save(); render();
  }
  function reset() {
    state.picks = []; state.custom = []; state.replay = false; state.viewSeat = null; cache.key = null;
    rebuild(); save(); render();
  }

  /* ---------------- render helpers ---------------- */
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  };
  const posBadge = function (pos) {
    return '<span class="pos pos-' + pos + '">' + (pos === "DST" ? "D/ST" : pos) + "</span>";
  };
  const flags = function (arr) {
    return (arr || []).map(function (f) {
      return '<span class="flag f-' + f + '">' + FLAG_LABEL[f] + "</span>";
    }).join(" ");
  };
  const pickLabel = function (overall) {
    const r = E.roundForPick(overall);
    const i = overall - (r - 1) * L.teams;
    return r + "." + String(i).padStart(2, "0");
  };
  /* Plugins (e.g. a recorded-draft file) may override naming and paint after
     every render. That is the whole extension surface. */
  const hooks = { teamName: null, afterRender: [] };
  const teamName = function (seat) {
    const n = hooks.teamName && hooks.teamName(seat);
    if (n) return n;
    return seat === L.mySeat ? "You (" + seat + ")" : "Team " + seat;
  };

  /* ---------------- render ---------------- */
  function render() {
    document.querySelector(".stat.brand .l").textContent = L.name;
    const a = analysis();
    renderStatus(a);
    renderPool(a);
    renderRoster(a);
    renderTeams(a);
    renderLog(a);
    for (const fn of hooks.afterRender) { try { fn(a); } catch (e) {} }
  }

  function renderStatus(a) {
    const c = a.c;
    document.getElementById("sPick").textContent = c.over ? "-" : pickLabel(c.overall);
    document.getElementById("sClockV").textContent = c.over ? "Draft complete" : teamName(c.onClock);
    const myNext = c.over ? null : E.nextPickForSeat(L.mySeat, c.overall);
    document.getElementById("sNext").textContent = myNext
      ? "#" + myNext + (myNext === c.overall ? "" : " (" + (myNext - c.overall) + " away)")
      : "-";
    document.getElementById("bUndo").disabled = state.picks.length === 0;
    document.getElementById("bAuto").disabled = c.over;
  }

  function renderPool(a) {
    const taken = takenIds();
    const scoreById = new Map();
    a.rec.list.forEach(function (r) { scoreById.set(r.player.id, r); });
    // The tool's advice lives IN the grid: the shortlist is hoisted to the top
    // of the default view and numbered. An explicit sort shows the plain grid.
    const recIndex = new Map();
    if (!a.c.over) a.rec.short.forEach(function (r, i) { recIndex.set(r.player.id, i + 1); });
    const hoist = ui.sort === "rank" && ui.dir === 1 && !ui.q && ui.pos === "ALL";

    let rows = players.filter(function (p) {
      if (!ui.showGone && taken.has(p.id)) return false;
      if (ui.pos !== "ALL" && p.pos !== ui.pos) return false;
      if (ui.q && p.name.toLowerCase().indexOf(ui.q) === -1) return false;
      return true;
    });

    const key = ui.sort, dir = ui.dir;
    rows.sort(function (x, y) {
      const get = function (p) {
        const r = scoreById.get(p.id);
        if (key === "score")   return r ? r.score : -Infinity;
        if (key === "value")   return r ? r.value : -Infinity;
        if (key === "name")    return p.name.toLowerCase();
        if (key === "pos")     return POS_ORDER.indexOf(p.pos);
        return p[key];
      };
      if (hoist) {
        const rx = recIndex.get(x.id) || 99, ry = recIndex.get(y.id) || 99;
        if (rx !== ry) return rx - ry;
      }
      const xv = get(x), yv = get(y);
      if (xv < yv) return -dir;
      if (xv > yv) return dir;
      return x.rank - y.rank;
    });

    const body = rows.map(function (p) {
      const r = scoreById.get(p.id);
      const gone = taken.has(p.id);
      const rn = gone ? null : recIndex.get(p.id);
      const why = rn && r ? E.explain(r, a.rec.def)[0] : "";
      return '<tr class="row' + (gone ? " gone" : "") + (rn ? " rec" : "") + '" data-id="' + p.id + '"' +
             (why ? ' title="' + esc(why) + '"' : "") + '>' +
        '<td class="l tiny">' + (p.custom ? "+" : p.rank) + "</td>" +
        '<td class="l">' + posBadge(p.pos) + "</td>" +
        '<td class="l">' + (rn ? '<span class="recno">' + rn + "</span> " : "") +
          '<span class="pname">' + esc(p.name) + "</span> " + flags(p.flags) + "</td>" +
        '<td class="l tiny">' + esc(p.team) + "</td>" +
        '<td class="tiny">' + (p.bye || "-") + "</td>" +
        '<td class="mono">' + p.proj.toFixed(0) + "</td>" +
      "</tr>";
    }).join("");

    document.getElementById("poolBody").innerHTML = body ||
      '<tr><td colspan="6" class="empty">No players match.</td></tr>';
    document.getElementById("poolSub").innerHTML = "<b>" + rows.length + "</b> shown";

    document.querySelectorAll("table.pool th[data-sort]").forEach(function (th) {
      if (th.dataset.sort === ui.sort) th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
  }

  function renderRoster(a) {
    const seat = state.viewSeat || L.mySeat;
    const ps = seatPlayers(seat);
    document.getElementById("rosterTitle").textContent = teamName(seat);
    document.getElementById("rosterSub").textContent =
      ps.length + " / " + L.rosterSize + (state.viewSeat ? " · pinned" : "");
    const lineup = E.buildLineup(ps);
    const byeCount = {};
    lineup.slice(0, L.starterCount).forEach(function (s) {
      if (s.player && s.player.bye) byeCount[s.player.bye] = (byeCount[s.player.bye] || 0) + 1;
    });
    document.getElementById("slots").innerHTML = lineup.map(function (s) {
      const bench = s.slot === "BE" || s.slot === "IR";
      const p = s.player;
      const clash = p && p.bye && byeCount[p.bye] >= 3 && !bench;
      return '<div class="slot' + (bench ? " bench" : "") + '">' +
        '<span class="sl">' + s.slot + "</span>" +
        '<span class="pl' + (p ? "" : " empty2") + '">' + (p ? esc(p.name) : "open") + "</span>" +
        '<span class="by' + (clash ? " clash" : "") + '">' + (p ? (p.bye || "-") : "") + "</span>" +
      "</div>";
    }).join("");

    return; // needline removed: open slots already show what is missing
    const pills = POS_ORDER.map(function (pos) {
      const startNeed = pos === "DST" ? L.starters.DST : (L.starters[pos] || 0);
      const hot = def.need[pos] > 0;
      return '<span class="pill' + (hot ? " hot" : "") + '">' +
        (pos === "DST" ? "D/ST" : pos) + " " + counts[pos] + "/" + startNeed + "</span>";
    });
    pills.push('<span class="pill' + (def.flexNeed ? " hot" : "") + '">FLEX ' +
      (def.flexNeed ? 0 : 1) + "/1</span>");
    document.getElementById("needline").innerHTML = pills.join("");
  }

  function renderTeams(a) {
    const c = a.c;
    document.getElementById("leagueSub").innerHTML =
      "you are seat " + L.mySeat + " &middot; click a team to view its roster";
    const viewed = state.viewSeat || L.mySeat;
    let html = "";
    for (let seat = 1; seat <= L.teams; seat++) {
      const ps = seatPlayers(seat);
      html += '<div class="tm' + (seat === viewed ? " sel" : "") +
              (seat === c.onClock ? " oc" : "") + '" data-seat="' + seat + '">' +
        "<h4>" + esc(teamName(seat)) + "<span>" + ps.length + "</span></h4><ol>" +
        ps.map(function (p) {
          return "<li>" + posBadge(p.pos) + " " + esc(p.name) + "</li>";
        }).join("") + "</ol></div>";
    }
    document.getElementById("teams").innerHTML = html;
  }

  function renderLog(a) {
    const rows = state.picks.slice().reverse().map(function (pk) {
      const p = pk.playerId === null ? null : byId(pk.playerId);
      if (!p) {
        return '<div class="logrow">' +
          '<span class="ov">' + pickLabel(pk.overall) + "</span>" +
          '<span class="tiny">-</span>' +
          '<span class="tiny">not on this board</span>' +
          '<span class="ov">' + pk.seat + "</span></div>";
      }
      return '<div class="logrow">' +
        '<span class="ov">' + pickLabel(pk.overall) + "</span>" +
        "<span>" + posBadge(p.pos) + "</span>" +
        "<span>" + esc(p.name) + "</span>" +
        '<span class="ov">' + pk.seat + "</span>" +
      "</div>";
    }).join("");
    document.getElementById("log").innerHTML = rows ||
      '<div class="empty">No picks yet.</div>';
    document.getElementById("logSub").textContent = state.picks.length + " picks";
  }

  /* ---------------- settings ---------------- */
  const $ = function (id) { return document.getElementById(id); };
  const CFG_FIELDS = {
    starters: { QB:"stQB", RB:"stRB", WR:"stWR", TE:"stTE", FLEX:"stFLEX", K:"stK", DST:"stDST" },
    maxPos:   { QB:"mxQB", RB:"mxRB", WR:"mxWR", TE:"mxTE", K:"mxK", DST:"mxDST" },
    points:   { rec:"pRec", passTD:"pPassTD", td:"pTD", passYd:"pPassYd",
                rushYd:"pRushYd", recYd:"pRecYd", int:"pInt", fumble:"pFum" },
    rankWeights: { rw:"wRW", pfn:"wPFN", cbs:"wCBS", espn:"wESPN", prior:"wPrior" }
  };
  function fillSettings(cfg) {
    $("sName").value = cfg.name;
    $("sTeams").value = cfg.teams;
    $("sSeat").value = cfg.mySeat;
    $("sRoster").value = cfg.rosterSize;
    $("sSF").checked = !!cfg.superflex;
    for (const group in CFG_FIELDS)
      for (const k in CFG_FIELDS[group]) $(CFG_FIELDS[group][k]).value = cfg[group][k];
  }
  function readSettings() {
    const cfg = {
      name: $("sName").value.trim(),
      teams: +$("sTeams").value, mySeat: +$("sSeat").value,
      rosterSize: +$("sRoster").value, superflex: $("sSF").checked
    };
    for (const group in CFG_FIELDS) cfg[group] = {};
    for (const group in CFG_FIELDS)
      for (const k in CFG_FIELDS[group]) cfg[group][k] = +$(CFG_FIELDS[group][k]).value;
    return cfg;
  }
  function structural(a, b) {
    return a.teams !== b.teams || a.rosterSize !== b.rosterSize ||
      JSON.stringify(a.starters) !== JSON.stringify(b.starters) || a.superflex !== b.superflex;
  }
  /* Returns false when the user declines the reset — the dialog stays open
     so their edits are not lost. */
  function applySettings() {
    const before = E.getConfig();
    const cfg = readSettings();
    if (structural(before, cfg) && state.picks.length &&
        !window.confirm("Changing the league shape resets the " + state.picks.length + " logged picks. Continue?")) {
      return false;
    }
    E.configure(cfg);
    if (structural(before, E.getConfig())) { state.picks = []; state.replay = false; state.viewSeat = null; }
    if (state.viewSeat > L.teams) state.viewSeat = null;
    saveConfig();
    cache.key = null; rebuild(); save(); render();
    return true;
  }

  /* ---------------- events ---------------- */
  function wire() {
    $("bSettings").addEventListener("click", function () {
      fillSettings(E.getConfig());
      $("dSettings").showModal();
    });
    $("bFactory").addEventListener("click", function () { fillSettings(FACTORY); });
    // Applied synchronously on the click — the dialog's close event fires in a
    // queued task, which is too late for anything reading state right after.
    $("bSaveSettings").addEventListener("click", function (e) {
      e.preventDefault();
      if (applySettings()) $("dSettings").close("save");
    });
    document.getElementById("poolBody").addEventListener("click", function (e) {
      const tr = e.target.closest("tr.row");
      if (tr) draft(+tr.dataset.id);
    });
    document.getElementById("bUndo").addEventListener("click", undo);
    document.getElementById("bAuto").addEventListener("click", function () {
      if (autoOne()) { cache.key = null; save(); render(); }
    });
    document.getElementById("teams").addEventListener("click", function (e) {
      const tm = e.target.closest(".tm");
      if (!tm) return;
      const seat = +tm.dataset.seat;
      state.viewSeat = state.viewSeat === seat ? null : seat;   // click again to follow the clock
      save(); render();
    });
    document.getElementById("bReset").addEventListener("click", function () {
      if (state.picks.length && !window.confirm("Clear all " + state.picks.length + " picks?")) return;
      reset();
    });
    document.getElementById("bShowGone").addEventListener("click", function (e) {
      ui.showGone = !ui.showGone;
      e.currentTarget.classList.toggle("primary", ui.showGone);
      e.currentTarget.textContent = ui.showGone ? "Hide drafted" : "Show drafted";
      render();
    });
    document.querySelectorAll(".toolbar .chip[data-pos]").forEach(function (b) {
      b.addEventListener("click", function () {
        ui.pos = b.dataset.pos;
        document.querySelectorAll(".toolbar .chip[data-pos]").forEach(function (o) {
          o.setAttribute("aria-pressed", o === b ? "true" : "false");
        });
        render();
      });
    });
    const q = document.getElementById("q");
    q.addEventListener("input", function () { ui.q = q.value.toLowerCase().trim(); render(); });
    q.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      const first = document.querySelector("#poolBody tr.row:not(.gone)");
      if (first) { draft(+first.dataset.id); q.value = ""; ui.q = ""; render(); }
    });
    document.querySelectorAll("table.pool th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () {
        const k = th.dataset.sort;
        if (ui.sort === k) ui.dir = -ui.dir;
        else { ui.sort = k; ui.dir = (k === "rank" || k === "name" || k === "pos") ? 1 : -1; }
        render();
      });
    });
    document.addEventListener("keydown", function (e) {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.key === "/") { e.preventDefault(); q.focus(); q.select(); }
      if (e.key === "u") { e.preventDefault(); undo(); }
    });
  }

  loadConfig();
  load();
  rebuild();
  wire();
  render();
  window.__draft = { state, ctx, analysis, draft, undo, simAll,
                     setSeed: function (n) { botSeed = n; },
                     autoOne, reset, render, seatPlayers, hooks, teamName,
                     refresh: function () { cache.key = null; save(); render(); },
                     get players() { return players; }, E };
})();
