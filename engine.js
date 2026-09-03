/* Draft engine: projections -> VOR -> survival simulation -> recommendations.
   Pure functions, no DOM. Runs in the browser and under Node (for tests). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    const d = require("./data.js");
    module.exports = factory(d.BYES, d.TIERS, d.RAW_PLAYERS);
  } else {
    // data.js declares these with `const`, so they are lexical globals, not
    // properties of window — reference them by bare identifier.
    root.Engine = factory(BYES, TIERS, RAW_PLAYERS);
  }
})(typeof self !== "undefined" ? self : this, function (BYES, TIERS, RAW_PLAYERS) {

  /* ---------- league configuration ----------
     Everything below is the NY-league DEFAULT. configure(cfg) rewrites the
     whole derived layer (replacement ranks, need curves, lineup template,
     scoring scales) so the same engine serves any roster shape. */
  const LEAGUE = {
    name: "NY League 2026",
    teams: 12,
    rosterSize: 16,
    mySeat: 6,                       // which seat YOU hold; advice itself stays seat-agnostic
    starters: { QB:1, RB:2, WR:2, TE:1, FLEX:1, K:1, DST:1 },
    superflex: false,
    flexEligible: ["RB","WR","TE"],
    maxPos: { QB:4, RB:8, WR:8, TE:3, K:3, DST:3 },
    benchSlots: 7,
    irSlots: 1,
    points: { passYd:0.04, passTD:4, int:-2, rushYd:0.1, rec:1, recYd:0.1, td:6, fumble:-2 },
    /* How much each ranking source counts in the board order. Sources are
       Sep 1 2026 snapshots shipped per player in data.js; missing sources
       renormalize away. All zeros falls back to the stored order. */
    rankWeights: { rw:0.35, pfn:0.25, prior:0.20, cbs:0.10, espn:0.10 }
  };
  LEAGUE.rounds = LEAGUE.rosterSize;
  LEAGUE.totalPicks = LEAGUE.teams * LEAGUE.rounds;

  /* Scoring changes what a position is WORTH, and the only per-player number
     we carry is a season projection under the default rules. So scoring is
     applied as a per-position rescale: one representative season stat line
     per position, valued under your points vs the defaults. It re-weights
     positions (6-pt passing TDs lift every QB ~10%), not individual players. */
  const DEFAULT_POINTS = { passYd:0.04, passTD:4, int:-2, rushYd:0.1, rec:1, recYd:0.1, td:6, fumble:-2 };
  const REP_LINES = {
    QB: { passYd:4300, passTD:30, int:11, rushYd:350, td:3, fumble:5 },
    RB: { rushYd:1150, td:11, rec:48, recYd:380, fumble:2 },
    WR: { rec:92, recYd:1180, td:7, rushYd:60, fumble:1 },
    TE: { rec:74, recYd:810, td:6, fumble:1 }
  };
  function lineValue(line, pts) {
    let v = 0;
    for (const k in line) v += line[k] * (pts[k] || 0);
    return v;
  }
  const POS_SCALE = { QB:1, RB:1, WR:1, TE:1, K:1, DST:1 };

  /* ---------- projection curves ----------
     Full-PPR season totals under THIS scoring (rec 1.0, 0.1/yd, 6 rush+rec TD,
     4 pass TD, 0.04 pass yd, -2 INT, -2 FUM). Anchored at realistic lines and
     interpolated by rank within position. These are my estimates derived from
     the consensus rank order, not a published projection set. */
  const CURVES = {
    RB:  [[1,325],[2,308],[3,290],[4,274],[5,259],[6,245],[7,232],[8,220],[10,211],[12,195],[14,185],[16,175],[18,166],[20,158],[24,147],[28,129],[32,120],[36,110],[40,96],[50,70],[60,52]],
    WR:  [[1,358],[2,335],[3,315],[4,303],[5,294],[6,283],[8,268],[10,255],[12,245],[14,234],[16,223],[18,216],[20,210],[24,192],[28,183],[32,171],[34,164],[40,150],[46,138],[50,126],[58,108],[65,95]],
    TE:  [[1,237],[2,218],[3,196],[4,180],[5,170],[6,162],[7,155],[8,149],[10,140],[12,132],[14,126],[16,119],[18,112],[20,106]],
    QB:  [[1,404],[2,381],[3,362],[4,340],[5,330],[6,320],[7,312],[8,305],[9,298],[10,292],[12,281],[13,276],[14,271],[16,262],[18,253],[20,245]],
    K:   [[1,168],[2,158],[3,152],[4,146],[5,141],[8,131],[12,122],[13,121],[16,114],[20,107]],
    DST: [[1,171],[2,155],[3,144],[4,135],[5,128],[8,110],[12,95],[13,92],[16,84],[20,76]]
  };

  /* Replacement level = the player you can realistically get off waivers.
     RB/WR baselines account for the FLEX absorbing ~6 of each. */
  const REPLACEMENT_RANK = { QB:13, RB:32, WR:34, TE:14, K:13, DST:13 };

  /* Raw VOR overrates positions you can only start one of, or that are fully
     streamable week to week. This is the correction, not a fudge factor. */
  const POS_ADJ = { QB:0.62, RB:1.0, WR:1.0, TE:0.90, K:0.32, DST:0.38 };

  /* What managers actually roster, as opposed to what the rules permit. */
  const BOT_MAX = { QB:2, RB:8, WR:8, TE:2, K:1, DST:2 };

  function curveRaw(pos, rank) {
    const c = CURVES[pos];
    if (!c) return 0;
    if (rank <= c[0][0]) return c[0][1];
    for (let i = 1; i < c.length; i++) {
      if (rank <= c[i][0]) {
        const [r0, v0] = c[i - 1], [r1, v1] = c[i];
        return v0 + (v1 - v0) * ((rank - r0) / (r1 - r0));
      }
    }
    // extrapolate past the last anchor along the final slope, floored at 0
    const [rA, vA] = c[c.length - 2], [rB, vB] = c[c.length - 1];
    const slope = (vB - vA) / (rB - rA);
    return Math.max(0, vB + slope * (rank - rB));
  }
  function curveValue(pos, rank) {
    return curveRaw(pos, rank) * (POS_SCALE[pos] || 1);
  }

  /* ---------- build the player pool ----------
     Board order is a WEIGHTED BLEND of the ranking sources each player ships
     with (rw = RotoWire consensus, pfn = Pro Football Network, cbs = CBS,
     espn = ESPN draft-day, prior = this board's hand-tuned Aug rank),
     renormalized over whichever sources cover the player. Skill players sort
     by the blend; D/ST and K keep their stored blocks at the tail.
     IDs are the player's fixed position in RAW_PLAYERS, NOT the board rank —
     logged picks must survive a re-weighting. */
  const TIER_BY_INDEX = RAW_PLAYERS
    .filter((r) => r[2] !== "DST" && r[2] !== "K").map((r) => r[4]);
  function blendRank(src, stored) {
    const W = LEAGUE.rankWeights;
    let tw = 0, acc = 0;
    if (src) for (const k in W) {
      if (src[k] !== undefined) { tw += W[k]; acc += W[k] * src[k]; }
    }
    return tw > 0 ? acc / tw : stored;
  }
  function buildPlayers() {
    const raw = RAW_PLAYERS.map((r, i) => {
      const [stored, name, pos, team, tier, note, flags, src] = r;
      return {
        id: i + 1, stored, name, pos, team, tier,
        note: note || "", flags: flags || [], src: src || null,
        bye: BYES[team] || 0,
        key: (pos === "DST" || pos === "K") ? 100000 + stored : blendRank(src, stored)
      };
    });
    raw.sort((a, b) => a.key - b.key || a.stored - b.stored);
    const posCount = {};
    let skillIdx = 0;
    return raw.map((p, idx) => {
      posCount[p.pos] = (posCount[p.pos] || 0) + 1;
      const posRank = posCount[p.pos];
      const proj = curveValue(p.pos, posRank);
      const repl = curveValue(p.pos, REPLACEMENT_RANK[p.pos]);
      const vor = proj - repl;
      const tier = (p.pos === "DST" || p.pos === "K")
        ? p.tier
        : TIER_BY_INDEX[Math.min(skillIdx++, TIER_BY_INDEX.length - 1)];
      return {
        id: p.id, rank: idx + 1, name: p.name, pos: p.pos, team: p.team, tier,
        note: p.note, flags: p.flags, src: p.src,
        bye: p.bye, posRank,
        proj: Math.round(proj * 10) / 10,
        vor: Math.round(vor * 10) / 10,
        vorAdj: Math.round(vor * POS_ADJ[p.pos] * 10) / 10
      };
    });
  }

  /* ---------- snake draft order ---------- */
  function seatForPick(overall) {           // overall is 1-indexed
    const r = Math.ceil(overall / LEAGUE.teams);
    const i = overall - (r - 1) * LEAGUE.teams;     // 1..teams
    return r % 2 === 1 ? i : LEAGUE.teams - i + 1;  // 1-indexed seat
  }
  function roundForPick(overall) { return Math.ceil(overall / LEAGUE.teams); }
  function pickForSeatRound(seat, round) {
    return (round - 1) * LEAGUE.teams + (round % 2 === 1 ? seat : LEAGUE.teams - seat + 1);
  }
  function myPicks(seat) {
    const out = [];
    for (let r = 1; r <= LEAGUE.rounds; r++) out.push(pickForSeatRound(seat, r));
    return out;
  }
  function nextPickForSeat(seat, afterOverall) {
    const all = myPicks(seat);
    for (const p of all) if (p >= afterOverall) return p;
    return null;
  }

  /* ---------- roster shape ---------- */
  function emptyCounts() { return { QB:0, RB:0, WR:0, TE:0, K:0, DST:0 }; }
  function countsFor(players) {
    const c = emptyCounts();
    for (const p of players) c[p.pos]++;
    return c;
  }

  /* Fill the starting lineup greedily by projection, then bench. */
  function buildLineup(players) {
    const S = LEAGUE.starters, slots = [];
    const put = (n, slot, elig) => { for (let i = 0; i < (n || 0); i++) slots.push({ slot, elig }); };
    put(S.QB, "QB", ["QB"]);
    put(S.RB, "RB", ["RB"]);
    put(S.WR, "WR", ["WR"]);
    put(S.TE, "TE", ["TE"]);
    put(S.FLEX, "FLEX", LEAGUE.flexEligible);
    put(S.DST, "D/ST", ["DST"]);
    put(S.K, "K", ["K"]);
    for (let i = 0; i < LEAGUE.benchSlots; i++) slots.push({ slot:"BE", elig:null });
    slots.push({ slot:"IR", elig:null });

    const filled = slots.map((s) => ({ ...s, player: null }));
    const pool = players.slice().sort((a, b) => b.proj - a.proj);
    const left = [];
    for (const p of pool) {
      let placed = false;
      for (const f of filled) {
        if (f.elig && !f.player && f.elig.indexOf(p.pos) > -1) { f.player = p; placed = true; break; }
      }
      if (!placed) left.push(p);
    }
    for (const p of left) {
      const f = filled.find((x) => !x.elig && !x.player);
      if (f) f.player = p;
    }
    return filled;
  }

  /* How many *starting* slots this position still needs filled. */
  function starterDeficit(counts) {
    const need = { QB:0, RB:0, WR:0, TE:0, K:0, DST:0 };
    need.QB  = Math.max(0, LEAGUE.starters.QB  - counts.QB);
    need.RB  = Math.max(0, LEAGUE.starters.RB  - counts.RB);
    need.WR  = Math.max(0, LEAGUE.starters.WR  - counts.WR);
    need.TE  = Math.max(0, LEAGUE.starters.TE  - counts.TE);
    need.K   = Math.max(0, LEAGUE.starters.K   - counts.K);
    need.DST = Math.max(0, LEAGUE.starters.DST - counts.DST);
    // FLEX is satisfied by any surplus RB/WR/TE
    let surplus = 0;
    for (const pos of LEAGUE.flexEligible)
      surplus += Math.max(0, counts[pos] - (LEAGUE.starters[pos] || 0));
    const flexNeed = Math.max(0, LEAGUE.starters.FLEX - surplus);
    return { need, flexNeed, total: need.QB+need.RB+need.WR+need.TE+need.K+need.DST+flexNeed };
  }

  /* Rebuilt by configure(): starters get a premium, flex-shared positions a
     1.0/0.95 cushion, then a bench-depth tail. */
  const NEED_CURVE = {};
  function needCurveFor(pos) {
    const S = LEAGUE.starters[pos] || 0;
    const isFlex = LEAGUE.flexEligible.indexOf(pos) > -1;
    const multi = S >= 2;
    const out = [];
    for (let i = 0; i < S; i++) out.push(multi ? Math.round((1 + 0.06 * (S - i + 1)) * 100) / 100 : 1.0);
    if (isFlex && multi) for (let j = 0; j <= (LEAGUE.starters.FLEX || 0); j++) out.push(1.0 - 0.05 * j);
    let tail = multi ? [0.85, 0.70, 0.50, 0.32] : [0.33, 0.10, 0.03];
    if (!multi && isFlex && pos === "QB") tail = [0.92, 0.35, 0.10];   // superflex QB2 is a starter in waiting
    return out.concat(tail);
  }

  /* picksLeft = your remaining picks INCLUDING the one you're making now.
     supply = how many of each position are still on the board. */
  function needMultiplier(pos, counts, picksLeft, supply) {
    if (!(LEAGUE.starters[pos] || 0) && LEAGUE.flexEligible.indexOf(pos) === -1) return 0;
    if (counts[pos] >= (BOT_MAX[pos] || LEAGUE.maxPos[pos])) return 0;
    // Practical caps, tighter than the league maximums. The rules allow three
    // kickers and three defenses; nobody sane rosters them. A second D/ST is a
    // real streaming play, a second kicker never is.
    if (pos === "K")   return counts.K < (LEAGUE.starters.K || 0) ? 0.04 : 0;
    if (pos === "DST") return counts.DST < (LEAGUE.starters.DST || 0) ? 0.05 : 0.03;
    const curve = NEED_CURVE[pos];
    const n = counts[pos];
    return n < curve.length ? curve[n] : 0;
  }

  /* An unfilled STARTING slot stops being a preference and becomes an
     obligation in two situations, and this has to be an ADDITIVE bonus rather
     than a bigger multiplier. Marginal value is floored at zero, so by the time
     you are scraping the bottom of a position every candidate is worth 0 and
     multiplying 0 by any need at all still leaves 0 -- which is how a draft
     ends with no quarterback on the roster.

       out of slack -- you have exactly as many picks left as empty slots
       out of supply -- the shelf for that position is nearly bare

     Supply thresholds differ by position because the shelves are different
     sizes: eleven rivals are also taking exactly one kicker from a pool of ten,
     while 32 defenses means one is always left over. */
  const FORCED_PRIORITY   = { QB:5, TE:4, RB:3, WR:3, K:2, DST:1 };
  /* Roughly "could this shelf empty before my next turn?". At seat 6 the gap
     between picks is 11 to 13, so a shelf of five can vanish inside one gap. */
  const SCARCE_SUPPLY     = { QB:7, TE:7, RB:8, WR:8, K:5, DST:5 };

  function forcedBonus(pos, counts, picksLeft, supply) {
    if (picksLeft <= 0) return 0;
    if (counts[pos] >= (BOT_MAX[pos] || LEAGUE.maxPos[pos])) return 0;
    const def = starterDeficit(counts);
    const hard = def.need[pos] > 0;
    const flexFill = def.flexNeed > 0 && LEAGUE.flexEligible.indexOf(pos) > -1;
    if (!hard && !flexFill) return 0;

    const outOfSlack = picksLeft - def.total <= 0;
    const left = supply && supply[pos] !== undefined ? supply[pos] : Infinity;
    const outOfSupply = hard && left <= SCARCE_SUPPLY[pos];
    if (!outOfSlack && !outOfSupply) return 0;

    return 1000 + (hard ? FORCED_PRIORITY[pos] * 10 : 5);
  }

  function forcedReason(pos, counts, picksLeft, supply) {
    if (!forcedBonus(pos, counts, picksLeft, supply)) return null;
    const def = starterDeficit(counts);
    if (def.need[pos] > 0 && supply && supply[pos] <= SCARCE_SUPPLY[pos]) {
      return { kind: "supply", left: supply[pos] };
    }
    return { kind: "slack", picksLeft, slots: def.total };
  }

  /* The forced bonus is deliberately huge, which means one scarce position can
     fill every slot of a top-five list. That is correct arithmetic and a
     useless board: you want the best tight end AND the best back, not the five
     best tight ends. Cap how many of one position can appear. */
  /* Top n for the UI. A position cap keeps a forced fill (five tight ends at
     +1000) from crowding out everything else, but diversity for its own sake
     is worthless: nobody should see McBride at 1.01 because two RBs and two
     WRs already filled the list. So a capped player only gives up his slot
     when the best remaining alternative scores within `tol` of him. */
  function shortlist(list, n, maxPerPos, tol) {
    tol = tol === undefined ? 0.85 : tol;
    const seen = {}, out = [];
    for (let i = 0; i < list.length && out.length < n; i++) {
      const r = list[i], pos = r.player.pos;
      seen[pos] = seen[pos] || 0;
      if (seen[pos] >= maxPerPos) {
        // Two of a position you start ONE of (QB/TE/K/DST) is already a full
        // menu — a third adds nothing you can act on. Only RB/WR, where you
        // start multiple, may keep a clearly better third option.
        if (r.forced || (LEAGUE.starters[pos] || 0) < 2) continue;
        let alt = null;
        for (let j = i + 1; j < list.length; j++) {
          if ((seen[list[j].player.pos] || 0) < maxPerPos) { alt = list[j]; break; }
        }
        if (alt && alt.score >= tol * r.score) continue;
      }
      seen[pos]++;
      out.push(r);
    }
    return out;
  }

  /* ---------- survival simulation ----------
     Monte Carlo over the next k picks. Other managers draft near the top of the
     remaining board with exponential noise (lambda controls how disciplined
     they are). Returns P(still available) per available player. */
  function makeRng(seed) {
    if (seed === undefined || seed === null) return Math.random;
    let s = seed >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }

  /* How far off board order the other managers pick, as a function of how
     deep into the draft we are. Calibrated on the real NY league draft:
     round 1 picks averaged 0.9 slots off the board, rounds 2-5 about 4,
     rounds 6-10 about 11. Exponential weights with parameter lambda have a
     mean displacement of roughly lambda. */
  function lambdaFor(taken) {
    return Math.min(12, 1.2 + 0.1 * (taken || 0));
  }

  function survivalProbs(availSorted, k, opts) {
    opts = opts || {};
    const sims   = opts.sims   || 400;
    const lambda = opts.lambda || lambdaFor(opts.taken);
    const rng    = opts.rng || makeRng(opts.seed);
    const out = new Array(availSorted.length).fill(1);
    if (k <= 0 || availSorted.length === 0) return out;

    const N = Math.min(availSorted.length, 80);
    const W = new Float64Array(N);
    for (let i = 0; i < N; i++) W[i] = Math.exp(-i / lambda);
    const cum = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + W[i];

    const counts = new Float64Array(N);
    const pool = new Int32Array(N);
    const takes = Math.min(k, N);

    for (let s = 0; s < sims; s++) {
      for (let i = 0; i < N; i++) pool[i] = i;
      let len = N;
      for (let p = 0; p < takes; p++) {
        let r = rng() * cum[len];
        let lo = 0, hi = len - 1, pick = len - 1;
        while (lo <= hi) {                       // binary search on the prefix sums
          const mid = (lo + hi) >> 1;
          if (cum[mid + 1] >= r) { pick = mid; hi = mid - 1; } else { lo = mid + 1; }
        }
        for (let i = pick; i < len - 1; i++) pool[i] = pool[i + 1];
        len--;
      }
      for (let i = 0; i < len; i++) counts[pool[i]]++;
    }
    for (let i = 0; i < N; i++) out[i] = counts[i] / sims;
    return out;
  }

  /* Expected vorAdj of the best player at `pos` who survives to my next pick. */
  function expectedBestLater(avail, surv, pos) {
    const list = [];
    for (let i = 0; i < avail.length; i++) {
      if (avail[i].pos === pos) list.push({ v: avail[i].vorAdj, s: surv[i] });
    }
    list.sort((a, b) => b.v - a.v);
    let exp = 0, none = 1;
    for (const x of list) { exp += x.v * x.s * none; none *= (1 - x.s); if (none < 1e-4) break; }
    return exp;
  }

  /* ---------- the recommendation ---------- */
  const URGENCY_WEIGHT = 0.6;

  /* Two corrections that only matter in the late rounds, but matter a lot.

     1. A player worse than replacement has NEGATIVE VOR. Multiplied by a
        positive need that stays negative, which ranked every bench dart below
        a kicker and drained the kicker pool by pick 113. Marginal value bottoms
        out at zero: he is not worth less than nobody.

     2. Once everyone left is at or below replacement, VOR says they are all
        identical. They are not — the board order still carries information, so
        a small rank prior breaks the tie. It is scaled by need, so a position
        you are maxed out at gets no prior at all. */
  const RANK_PRIOR_MAX = 250;
  const RANK_PRIOR_WEIGHT = 0.02;
  function rankPrior(rank) {
    return Math.max(0.1, (RANK_PRIOR_MAX - rank) * RANK_PRIOR_WEIGHT);
  }

  function recommend(state, opts) {
    opts = opts || {};
    const players   = state.players;
    const takenIds  = state.takenIds;              // Set
    const myPlayers = state.myPlayers;             // array of player objects
    const picksLeft = state.picksLeft;             // including this pick
    const gap       = state.gap;                   // picks until my NEXT pick (0 if none)

    // Stacking starters on one bye costs you a real week. A nudge, not a veto:
    // never pass on a clearly better player to dodge a bye.
    const byeLoad = {};
    for (const p of myPlayers) if (p.bye) byeLoad[p.bye] = (byeLoad[p.bye] || 0) + 1;

    const avail = players.filter((p) => !takenIds.has(p.id))
                         .sort((a, b) => a.rank - b.rank);
    if (!avail.length) return { list: [], avail, surv: [], outlook: {} };

    const surv = survivalProbs(avail, gap, opts);
    const counts = countsFor(myPlayers);
    const def = starterDeficit(counts);

    const supply = { QB:0, RB:0, WR:0, TE:0, K:0, DST:0 };
    for (const p of avail) supply[p.pos]++;

    const outlook = {};
    for (const pos of ["QB","RB","WR","TE","K","DST"]) {
      outlook[pos] = { later: expectedBestLater(avail, surv, pos) };
    }

    // last-player-in-tier detection
    const tierRemaining = {};
    for (const p of avail) tierRemaining[p.tier] = (tierRemaining[p.tier] || 0) + 1;

    const list = avail.map((p, i) => {
      const need = needMultiplier(p.pos, counts, picksLeft, supply);
      const forced = forcedBonus(p.pos, counts, picksLeft, supply);
      const stacked = p.bye ? (byeLoad[p.bye] || 0) : 0;
      const byePenalty = stacked >= 3 ? 0.88 : (stacked === 2 ? 0.95 : 1);
      const value = Math.max(0, p.vorAdj) * need;
      const drop = Math.max(0, p.vorAdj - outlook[p.pos].later);
      const score = (value + URGENCY_WEIGHT * drop * need
                    + rankPrior(p.rank) * Math.min(1, need)) * byePenalty + forced;
      return {
        player: p,
        survive: surv[i],
        need: Math.round(need * 100) / 100,
        forced: forced > 0,
        forcedReason: forced > 0 ? forcedReason(p.pos, counts, picksLeft, supply) : null,
        byeStack: stacked,
        value: Math.round(value * 10) / 10,
        drop: Math.round(drop * 10) / 10,
        score: Math.round(score * 10) / 10,
        lastInTier: tierRemaining[p.tier] === 1
      };
    }).sort((a, b) => b.score - a.score || b.player.vorAdj - a.player.vorAdj || a.player.rank - b.player.rank);

    return { list, short: shortlist(list, 5, 2), avail, surv, outlook, counts, def, supply };
  }

  /* One line of justification — the single most decision-relevant fact,
     in priority order. The UI shows only the first. */
  function explain(rec, def) {
    const p = rec.player, out = [];
    const fr = rec.forcedReason;
    if (fr && fr.kind === "supply") {
      out.push(`Only ${fr.left} ${p.pos === "DST" ? "defenses" : p.pos + "s"} left and this roster still needs one.`);
    } else if (fr) {
      out.push(`Forced fill — ${fr.picksLeft} picks left, ${fr.slots} empty starting slots.`);
    }
    if (rec.drop >= 12) out.push(`Steep cliff at ${p.pos}: waiting a round costs about ${Math.round(rec.drop)} points.`);
    if (rec.lastInTier) out.push(`Last player in the "${TIERS[p.tier].label}" tier.`);
    const need = def && def.need;
    if (need && need[p.pos] > 0) out.push(`Fills an empty ${p.pos === "DST" ? "D/ST" : p.pos} slot.`);
    else if (def && def.flexNeed > 0 && LEAGUE.flexEligible.indexOf(p.pos) > -1) out.push("Fills the FLEX.");
    if (rec.need === 0 && !rec.forced) out.push("Already at the roster maximum here.");
    else if (rec.need <= 0.15) out.push("Low priority — this position is covered.");
    if (rec.byeStack >= 2) out.push(`Bye pileup: ${rec.byeStack} of this roster already off in Week ${p.bye}.`);
    if (p.flags.indexOf("inj") > -1) out.push("Injury flag — check his status before you count on him.");
    if (!out.length) out.push("Best value on the board.");
    return out;
  }

  /* ---------- CPU autopick for the other 11 teams ---------- */
  function autoPick(state, opts) {
    opts = opts || {};
    const lambda = opts.lambda || lambdaFor(state.takenIds.size);
    const rng = opts.rng || makeRng(opts.seed);
    const counts = countsFor(state.teamPlayers);
    let avail = state.players.filter((p) => !state.takenIds.has(p.id));
    if (!avail.length) return null;
    const supply = { QB:0, RB:0, WR:0, TE:0, K:0, DST:0 };
    for (const p of avail) supply[p.pos]++;
    // Hard roster rule: never exceed a positional maximum. Value alone will not
    // enforce this, because a maxed-out position still scores 0 and can win on
    // the rank tiebreak when everything else is also 0.
    avail = avail.filter((p) => counts[p.pos] < (BOT_MAX[p.pos] || LEAGUE.maxPos[p.pos]));
    // Nothing legal left on this board. Returning null tells the caller to log
    // an off-board pick, which is what really happens once a 186-player board
    // runs into a 192-pick draft — better than busting a roster limit.
    if (!avail.length) return null;
    const scored = avail.map((p) => {
      const need = needMultiplier(p.pos, counts, state.picksLeft, supply);
      return {
        p, s: Math.max(0, p.vorAdj) * need
              + forcedBonus(p.pos, counts, state.picksLeft, supply)
              + rankPrior(p.rank) * Math.min(1, need)
      };
    }).sort((a, b) => b.s - a.s || b.p.vorAdj - a.p.vorAdj || a.p.rank - b.p.rank);

    // A manager staring at an empty K/D-ST slot with no picks to spare does
    // not "get creative" — forced fills are taken, not sampled around.
    let N = Math.min(scored.length, 40), lam = lambda;
    if (scored[0].s >= 1000) {
      let f = 0;
      while (f < scored.length && scored[f].s >= 1000) f++;
      N = f; lam = 2;
    }
    let total = 0;
    const w = [];
    for (let i = 0; i < N; i++) { w.push(Math.exp(-i / lam)); total += w[i]; }
    let r = rng() * total;
    for (let i = 0; i < N; i++) { r -= w[i]; if (r <= 0) return scored[i].p; }
    return scored[0].p;
  }

  /* ---------- configuration ----------
     Rewrites LEAGUE and every table derived from it, in place, so live
     references stay valid. Passing {} re-derives the NY-league defaults. */
  function configure(cfg) {
    cfg = cfg || {};
    const num = (v, lo, hi, dflt) => {
      v = Number(v);
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
    };
    if (cfg.name !== undefined) LEAGUE.name = String(cfg.name).slice(0, 40) || LEAGUE.name;
    LEAGUE.teams = num(cfg.teams, 2, 16, LEAGUE.teams);
    if (cfg.starters) for (const k in LEAGUE.starters)
      LEAGUE.starters[k] = num(cfg.starters[k], 0, 4, LEAGUE.starters[k]);
    if (cfg.maxPos) for (const k in LEAGUE.maxPos)
      LEAGUE.maxPos[k] = num(cfg.maxPos[k], 0, 10, LEAGUE.maxPos[k]);
    if (cfg.points) for (const k in LEAGUE.points)
      LEAGUE.points[k] = num(cfg.points[k], -10, 10, LEAGUE.points[k]);
    if (cfg.superflex !== undefined) LEAGUE.superflex = !!cfg.superflex;
    if (cfg.rankWeights) for (const k in LEAGUE.rankWeights)
      LEAGUE.rankWeights[k] = num(cfg.rankWeights[k], 0, 1, LEAGUE.rankWeights[k]);

    const S = LEAGUE.starters;
    LEAGUE.starterCount = S.QB + S.RB + S.WR + S.TE + S.FLEX + S.K + S.DST;
    LEAGUE.rosterSize = num(cfg.rosterSize, LEAGUE.starterCount, 24, Math.max(LEAGUE.rosterSize, LEAGUE.starterCount));
    LEAGUE.mySeat = num(cfg.mySeat, 1, LEAGUE.teams, Math.min(LEAGUE.mySeat, LEAGUE.teams));
    LEAGUE.rounds = LEAGUE.rosterSize;
    LEAGUE.totalPicks = LEAGUE.teams * LEAGUE.rounds;
    LEAGUE.benchSlots = LEAGUE.rosterSize - LEAGUE.starterCount;
    LEAGUE.flexEligible = LEAGUE.superflex ? ["RB", "WR", "TE", "QB"] : ["RB", "WR", "TE"];

    // replacement level scales with how many starters the league consumes
    const T = LEAGUE.teams, F = S.FLEX || 0, sf = LEAGUE.superflex;
    REPLACEMENT_RANK.QB  = Math.max(2, Math.floor(T * S.QB + (sf ? T * F * 0.6 : 0) + 1));
    REPLACEMENT_RANK.RB  = Math.max(2, Math.floor(T * S.RB + T * F * 0.5 * (sf ? 0.7 : 1) + 2));
    REPLACEMENT_RANK.WR  = Math.max(2, Math.floor(T * S.WR + T * F * 0.5 * (sf ? 0.7 : 1) + 4));
    REPLACEMENT_RANK.TE  = Math.max(2, Math.floor(T * S.TE + T * F * 0.05 + 2));
    REPLACEMENT_RANK.K   = Math.max(2, T * (S.K || 1) + 1);
    REPLACEMENT_RANK.DST = Math.max(2, T * (S.DST || 1) + 1);

    POS_ADJ.QB  = (sf || S.QB >= 2) ? 1.0 : 0.62;
    POS_ADJ.TE  = S.TE >= 2 ? 1.0 : 0.90;
    POS_ADJ.K   = S.K ? 0.32 : 0;
    POS_ADJ.DST = S.DST ? 0.38 : 0;

    BOT_MAX.QB  = Math.min(LEAGUE.maxPos.QB, sf || S.QB >= 2 ? 3 : 2);
    BOT_MAX.RB  = LEAGUE.maxPos.RB;
    BOT_MAX.WR  = LEAGUE.maxPos.WR;
    BOT_MAX.TE  = Math.min(LEAGUE.maxPos.TE, Math.max(2, S.TE + 1));
    BOT_MAX.K   = Math.min(LEAGUE.maxPos.K, S.K || 0);
    BOT_MAX.DST = Math.min(LEAGUE.maxPos.DST, S.DST ? S.DST + 1 : 0);

    const base = { QB:7, TE:7, RB:8, WR:8, K:5, DST:5 };
    for (const k in base) SCARCE_SUPPLY[k] = Math.max(2, Math.round(base[k] * T / 12));

    for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      NEED_CURVE[pos] = needCurveFor(pos);
      POS_SCALE[pos] = REP_LINES[pos]
        ? lineValue(REP_LINES[pos], LEAGUE.points) / lineValue(REP_LINES[pos], DEFAULT_POINTS)
        : 1;
    }
    return LEAGUE;
  }
  function getConfig() {
    return JSON.parse(JSON.stringify({
      name: LEAGUE.name, teams: LEAGUE.teams, mySeat: LEAGUE.mySeat,
      rosterSize: LEAGUE.rosterSize, starters: LEAGUE.starters,
      maxPos: LEAGUE.maxPos, points: LEAGUE.points, superflex: LEAGUE.superflex,
      rankWeights: LEAGUE.rankWeights
    }));
  }
  configure({});

  return {
    LEAGUE, CURVES, REPLACEMENT_RANK, POS_ADJ, BOT_MAX, TIERS, BYES,
    configure, getConfig, DEFAULT_POINTS, POS_SCALE,
    curveValue, buildPlayers,
    seatForPick, roundForPick, pickForSeatRound, myPicks, nextPickForSeat,
    countsFor, emptyCounts, buildLineup, starterDeficit, needMultiplier, forcedBonus, rankPrior,
    makeRng, lambdaFor, survivalProbs, expectedBestLater, recommend, explain, autoPick, shortlist, forcedReason
  };
});
