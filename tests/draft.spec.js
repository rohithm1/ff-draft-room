const { test, expect } = require("@playwright/test");

const errors = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto("/index.html");
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForFunction(() => !!window.__draft);
});
test.afterEach(() => {
  expect(errors, "console/page errors: " + errors.join(" | ")).toEqual([]);
});

/* ---------- basics ---------- */

test("loads with the correct opening state", async ({ page }) => {
  await expect(page.locator("#sPick")).toHaveText("1.01");
  await expect(page.locator("#sClockV")).toHaveText("Team 1");
  await expect(page.locator("#poolBody tr.rec")).toHaveCount(5);
  await expect(page.locator("#poolBody tr.row").first().locator(".recno")).toHaveText("1");
  await expect(page.locator("#poolBody tr.row")).toHaveCount(224);
});

test("snake order is right through the first three rounds", async ({ page }) => {
  const seats = await page.evaluate(() => {
    const E = window.__draft.E;
    return Array.from({ length: 36 }, (_, i) => E.seatForPick(i + 1));
  });
  expect(seats.slice(0, 12)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
  expect(seats.slice(12, 24)).toEqual([12,11,10,9,8,7,6,5,4,3,2,1]);
  expect(seats.slice(24, 36)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
});

test("clicking a pool row drafts to the team on the clock", async ({ page }) => {
  const first = page.locator("#poolBody tr.row").first();
  const name = await first.locator(".pname").innerText();
  await first.click();
  await expect(page.locator("#sPick")).toHaveText("1.02");
  await expect(page.locator("#sClockV")).toHaveText("Team 2");
  await expect(page.locator("#log .logrow").first()).toContainText(name);
  const t1 = await page.evaluate(() => window.__draft.seatPlayers(1).map((p) => p.name));
  expect(t1).toEqual([name]);
});

test("autopick advances the clock one pick", async ({ page }) => {
  await page.click("#bAuto");
  await expect(page.locator("#sPick")).toHaveText("1.02");
  await expect(page.locator("#sClockV")).toHaveText("Team 2");
  await expect(page.locator("#poolBody tr.rec")).toHaveCount(5);
});

test("undo reverses a pick and restores the pool", async ({ page }) => {
  await page.click("#bAuto");
  const before = await page.locator("#poolBody tr.row").count();
  await page.locator("#poolBody tr.row").first().click();
  expect(await page.locator("#poolBody tr.row").count()).toBe(before - 1);
  await page.click("#bUndo");
  expect(await page.locator("#poolBody tr.row").count()).toBe(before);
  await expect(page.locator("#sPick")).toHaveText("1.02");
});

test("undo is disabled with no picks and re-enables after one", async ({ page }) => {
  await expect(page.locator("#bUndo")).toBeDisabled();
  await page.locator("#poolBody tr.row").first().click();
  await expect(page.locator("#bUndo")).toBeEnabled();
});

/* ---------- recommendations ---------- */

test("never recommends an already drafted player", async ({ page }) => {
  const bad = await page.evaluate(() => {
    const d = window.__draft;
    const problems = [];
    for (let i = 0; i < 90; i++) {
      const taken = new Set(d.state.picks.map((p) => p.playerId));
      for (const r of d.analysis().rec.list.slice(0, 8)) {
        if (taken.has(r.player.id)) problems.push("pick " + (i + 1) + ": " + r.player.name);
      }
      if (!d.autoOne()) break;
    }
    return problems;
  });
  expect(bad).toEqual([]);
});

test("does not recommend a kicker or defense while you still have slack", async ({ page }) => {
  const hits = await page.evaluate(() => {
    const d = window.__draft, E = d.E;
    const out = [];
    for (let i = 0; i < 192; i++) {
      const a = d.analysis();
      if (!a.rec.list.length) break;
      const counts = E.countsFor(a.team);
      const def = E.starterDeficit(counts);
      const slack = a.c.picksLeft - def.total;
      const top = a.rec.list[0].player;
      // Only meaningful while the board still has real skill players on it.
      // This board is 214 deep against 192 picks, so the tail legitimately runs
      // out of everything except defenses.
      const skillLeft = a.rec.avail.filter((p) => p.pos !== "K" && p.pos !== "DST").length;
      if (slack >= 2 && skillLeft >= 30 && (top.pos === "K" || top.pos === "DST")) {
        out.push("round " + a.c.round + ": " + top.name +
                 " (slack " + slack + ", " + skillLeft + " skill players left)");
      }
      if (!d.autoOne()) break;
    }
    return out;
  });
  expect(hits).toEqual([]);
});

test("top recommendation at 1.01 is a sane, available, high-VOR player", async ({ page }) => {
  const top = await page.evaluate(() => {
    const a = window.__draft.analysis();
    const r = a.rec.list[0];
    return { name: r.player.name, pos: r.player.pos, vorAdj: r.player.vorAdj,
             rank: r.player.rank, score: r.score };
  });
  expect(["RB", "WR", "TE"]).toContain(top.pos);
  expect(top.rank).toBeLessThanOrEqual(14);
  expect(top.vorAdj).toBeGreaterThan(90);
  await expect(page.locator("#poolBody tr.rec .pname").first()).toHaveText(top.name);
  const why = await page.locator("#poolBody tr.rec").first().getAttribute("title");
  expect(why.length).toBeGreaterThan(0);
});

test("the grid is always in rank order; the tool's five are badged in place", async ({ page }) => {
  const ranks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#poolBody tr.row td:first-child"))
      .slice(0, 40).map((td) => +td.textContent));
  const sorted = ranks.slice().sort((a, b) => a - b);
  expect(ranks, "# column reads in order").toEqual(sorted);
  await expect(page.locator("#poolBody tr.rec")).toHaveCount(5);
  const first = await page.locator("#poolBody tr.rec .pname").first().textContent();
  await page.locator("#poolBody tr.rec").first().click();      // Team 1 takes the top rec
  await expect(page.locator("#poolBody tr.rec")).toHaveCount(5);
  const next = await page.locator("#poolBody tr.rec .pname").first().textContent();
  expect(next).not.toBe(first);                                // advice recomputed for Team 2
});

/* ---------- the hard one: a complete draft ---------- */

test("a full 192-pick draft leaves every team a legal, startable roster", async ({ page }) => {
  const res = await page.evaluate(() => {
    const d = window.__draft, E = d.E, L = E.LEAGUE;
    d.reset();
    d.simAll();
    const real = d.state.picks.filter((p) => p.playerId !== null).map((p) => p.playerId);
    const teams = [];
    for (let s = 1; s <= L.teams; s++) {
      const ps = d.seatPlayers(s);
      teams.push({ seat: s, named: ps.length, counts: E.countsFor(ps) });
    }
    return {
      picks: d.state.picks.length,
      placeholders: d.state.picks.length - real.length,
      unique: new Set(real).size, real: real.length, teams
    };
  });

  expect(res.picks, "every pick in the draft is logged").toBe(192);
  expect(res.unique, "no player drafted twice").toBe(res.real);
  // 214 ranked players cover 192 picks
  // 186 ranked players against 192 picks, and bots refuse to bust roster caps,
  // so the tail of the draft is logged as off-board picks
  expect(res.placeholders).toBeLessThan(25);

  for (const t of res.teams) {
    expect(t.counts.QB,  "team " + t.seat + " QB").toBeGreaterThanOrEqual(1);
    expect(t.counts.RB,  "team " + t.seat + " RB").toBeGreaterThanOrEqual(2);
    expect(t.counts.WR,  "team " + t.seat + " WR").toBeGreaterThanOrEqual(2);
    expect(t.counts.TE,  "team " + t.seat + " TE").toBeGreaterThanOrEqual(1);
    expect(t.counts.DST, "team " + t.seat + " D/ST").toBeGreaterThanOrEqual(1);
    expect(t.counts.K,   "team " + t.seat + " K").toBeLessThanOrEqual(1);
    expect(t.counts.DST, "team " + t.seat + " D/ST cap").toBeLessThanOrEqual(2);
  }
  // ESPN ranks 10 kickers and there are 12 teams, so two managers end up
  // without one. That is the board's depth, not a bug in the fill logic.
  const withK = res.teams.filter((t) => t.counts.K >= 1).length;
  expect(withK).toBeGreaterThanOrEqual(10);
});

test("a seat following the tool's advice ends with a full lineup across eight seeded drafts", async ({ page }) => {
  // Seat 6 takes the top recommendation every turn; the other eleven use the
  // seeded bot. A failure is a real regression, not variance.
  const runs = await page.evaluate(() => {
    const d = window.__draft, E = d.E;
    const out = [];
    for (let seed = 1; seed <= 8; seed++) {
      d.reset();
      d.setSeed(seed);
      let g = 0;
      while (g++ < E.LEAGUE.totalPicks + 5) {
        const c = d.ctx();
        if (c.over) break;
        if (c.onClock === 6) {
          const top = d.analysis().rec.list[0];
          const usable = top && (top.forced || top.need > 0);
          d.state.picks.push({ overall: c.overall, seat: 6, playerId: usable ? top.player.id : null });
        } else if (!d.autoOne()) break;
      }
      const my = d.seatPlayers(6);
      const lineup = E.buildLineup(my).slice(0, 9);
      out.push({
        seed,
        open: lineup.filter((s) => !s.player).map((s) => s.slot),
        counts: E.countsFor(my),
        size: my.length
      });
    }
    d.setSeed(null);
    return out;
  });

  for (const r of runs) {
    expect(r.open, "advice-following seat left starting slots empty on seed " + r.seed).toEqual([]);
    expect(r.counts.DST, "seed " + r.seed + " defenses").toBeLessThanOrEqual(2);
    expect(r.counts.K,   "seed " + r.seed + " kickers").toBe(1);
    expect(r.size,       "seed " + r.seed + " roster size").toBeLessThanOrEqual(16);
  }
});

test("waits on QB and TE, and leaves K and D/ST to the last two rounds", async ({ page }) => {
  // The engine should arrive at the strategy on its own, not be told it.
  const r = await page.evaluate(() => {
    const d = window.__draft, E = d.E;
    const first = { QB: [], TE: [], K: [], DST: [] };
    for (let seed = 1; seed <= 10; seed++) {
      d.reset(); d.setSeed(seed);
      let g = 0;
      while (g++ < E.LEAGUE.totalPicks + 5) {
        const c = d.ctx();
        if (c.over) break;
        if (c.onClock === 6) {
          const top = d.analysis().rec.list[0];
          const usable = top && (top.forced || top.need > 0);
          d.state.picks.push({ overall: c.overall, seat: 6, playerId: usable ? top.player.id : null });
        } else if (!d.autoOne()) break;
      }
      for (const pos of Object.keys(first)) {
        const pk = d.state.picks.find((p) => {
          const pl = d.players.find((x) => x.id === p.playerId);
          return p.seat === 6 && pl && pl.pos === pos;
        });
        if (pk) first[pos].push(E.roundForPick(pk.overall));
      }
    }
    d.setSeed(null);
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    return { QB: med(first.QB), TE: med(first.TE), K: med(first.K), DST: med(first.DST) };
  });
  // 4-point passing TDs and a single TE slot mean neither is an early pick
  expect(r.QB, "median round of your first QB").toBeGreaterThanOrEqual(5);
  expect(r.TE, "median round of your first TE").toBeGreaterThanOrEqual(5);
  // and the two throwaway positions belong at the very end
  expect(r.K,   "median round of your kicker").toBeGreaterThanOrEqual(13);
  expect(r.DST, "median round of your defense").toBeGreaterThanOrEqual(13);
});

/* ---------- persistence ---------- */

test("picks survive a reload", async ({ page }) => {
  await page.click("#bAuto");
  await page.click("#bAuto");
  await page.locator("#poolBody tr.row").first().click();
  await page.reload();
  await page.waitForFunction(() => !!window.__draft);
  await expect(page.locator("#log .logrow")).toHaveCount(3);
  await expect(page.locator("#sPick")).toHaveText("1.04");
});

/* ---------- pool controls ---------- */

test("position filter narrows the pool", async ({ page }) => {
  await page.click('.toolbar .chip[data-pos="TE"]');
  const rows = page.locator("#poolBody tr.row");
  await expect(rows).toHaveCount(24);
  for (const t of await rows.locator("td.l .pos").allInnerTexts()) expect(t).toBe("TE");
});

test("search plus Enter drafts the top hit", async ({ page }) => {
  await page.fill("#q", "gibbs");
  await expect(page.locator("#poolBody tr.row")).toHaveCount(1);
  await page.press("#q", "Enter");
  await expect(page.locator("#log .logrow").first()).toContainText("Jahmyr Gibbs");
  await expect(page.locator("#q")).toHaveValue("");
});

test("show drafted reveals struck-through players", async ({ page }) => {
  await page.locator("#poolBody tr.row").first().click();
  await expect(page.locator("#poolBody tr.gone")).toHaveCount(0);
  await page.click("#bShowGone");
  await expect(page.locator("#poolBody tr.gone")).toHaveCount(1);
});

test("pool opens in board order and the rank header flips it", async ({ page }) => {
  await expect(page.locator("#poolBody tr.row").first().locator(".pname")).toHaveText("Jahmyr Gibbs");
  await page.click('th[data-sort="rank"]');
  await expect(page.locator("#poolBody tr.row").first().locator(".pname")).not.toHaveText("Jahmyr Gibbs");
  await page.click('th[data-sort="rank"]');
  await expect(page.locator("#poolBody tr.row").first().locator(".pname")).toHaveText("Jahmyr Gibbs");
});

/* ---------- roster panel ---------- */

test("your picks fill the lineup slots in the right order", async ({ page }) => {
  // Bots are random, so name a position rather than a player: take the best
  // available TE and QB at your first two turns and check where they land.
  const picked = await page.evaluate(() => {
    const d = window.__draft;
    const takeBest = (pos) => {
      while (d.ctx().onClock !== 6) d.autoOne();
      const taken = new Set(d.state.picks.map((p) => p.playerId));
      const best = d.players
        .filter((p) => p.pos === pos && !taken.has(p.id))
        .sort((a, b) => a.rank - b.rank)[0];
      d.draft(best.id);
      return best.name;
    };
    const out = { te: takeBest("TE"), qb: takeBest("QB") };
    d.state.viewSeat = 6; d.render();          // pin seat 6's roster for the assertions
    return out;
  });

  const slots = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#slots .slot")).map((s) => ({
      slot: s.querySelector(".sl").textContent,
      player: s.querySelector(".pl").textContent
    })));

  expect(slots.map((s) => s.slot).slice(0, 9))
    .toEqual(["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "D/ST", "K"]);
  expect(slots.find((s) => s.slot === "TE").player).toBe(picked.te);
  expect(slots.find((s) => s.slot === "QB").player).toBe(picked.qb);
  expect(slots.filter((s) => s.slot === "BE").length).toBe(7);
  expect(slots.filter((s) => s.slot === "IR").length).toBe(1);
});

test("a second tight end goes to the FLEX, not a bench slot", async ({ page }) => {
  const names = await page.evaluate(() => {
    const d = window.__draft;
    const out = [];
    for (let i = 0; i < 2; i++) {
      while (d.ctx().onClock !== 6) d.autoOne();
      const taken = new Set(d.state.picks.map((p) => p.playerId));
      const best = d.players.filter((p) => p.pos === "TE" && !taken.has(p.id))
                            .sort((a, b) => a.rank - b.rank)[0];
      d.draft(best.id);
      out.push(best.name);
    }
    d.state.viewSeat = 6; d.render();          // pin seat 6's roster for the assertion
    return out;
  });
  const flex = await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll("#slots .slot"))
      .find((x) => x.querySelector(".sl").textContent === "FLEX");
    return s.querySelector(".pl").textContent;
  });
  expect(names).toContain(flex);
});

test("the shortlist never fills up with one position", async ({ page }) => {
  const worst = await page.evaluate(() => {
    const d = window.__draft;
    d.setSeed(3);
    let maxSamePos = 0, maxForced = 0;
    for (let i = 0; i < 150; i++) {
      const short = d.analysis().rec.short;
      const tally = {}, forced = {};
      for (const r of short) {
        tally[r.player.pos] = (tally[r.player.pos] || 0) + 1;
        if (r.forced) forced[r.player.pos] = (forced[r.player.pos] || 0) + 1;
      }
      maxSamePos = Math.max(maxSamePos, ...Object.values(tally));
      maxForced = Math.max(maxForced, 0, ...Object.values(forced));
      if (!d.autoOne()) break;
    }
    d.setSeed(null);
    return { maxSamePos, maxForced };
  });
  // a third RB is fine when the alternatives are far worse; a forced fill never floods
  expect(worst.maxSamePos, "most players of one position shown at once").toBeLessThanOrEqual(3);
  expect(worst.maxForced, "forced fills shown at once").toBeLessThanOrEqual(2);
});

test("a forced pick explains which trigger actually fired", async ({ page }) => {
  const r = await page.evaluate(() => {
    const d = window.__draft, E = d.E;
    d.setSeed(4);
    const kinds = {}, shapes = [];
    for (let i = 0; i < 192; i++) {
      for (const rec of d.analysis().rec.short) {
        const fr = rec.forcedReason;
        if (!fr) continue;
        kinds[fr.kind] = (kinds[fr.kind] || 0) + 1;
        shapes.push(fr.kind === "supply"
          ? typeof fr.left === "number"
          : typeof fr.picksLeft === "number" && typeof fr.slots === "number");
      }
      if (!d.autoOne()) break;
    }
    d.setSeed(null);

    // The slack path is the safety net for a manager who is behind on several
    // slots at once, which a well-advised seat never reaches. Exercise it
    // directly rather than hoping a simulated draft stumbles into it.
    const behind = { QB: 0, RB: 2, WR: 2, TE: 0, K: 0, DST: 0 };
    const plenty = { QB: 15, RB: 40, WR: 50, TE: 15, K: 9, DST: 30 };
    const slack = E.forcedReason("QB", behind, 3, plenty);
    return { kinds, allShapesValid: shapes.every(Boolean), slack };
  });

  expect(r.kinds.supply, "supply-triggered fills seen in a draft").toBeGreaterThan(0);
  expect(r.allShapesValid, "every reason carries the numbers its text prints").toBe(true);
  expect(r.slack, "running out of picks forces a fill on its own").toEqual({
    kind: "slack", picksLeft: 3, slots: 5
  });
});

/* ---------- settings ---------- */

test("settings: changing the league shape resets picks and hides the recorded draft", async ({ page }) => {
  await page.locator("#poolBody tr.row").first().click();  // log one pick
  page.on("dialog", (d) => d.accept());
  await page.click("#bSettings");
  await page.fill("#sTeams", "10");
  await page.click("#bSaveSettings");
  const s = await page.evaluate(() => ({
    picks: window.__draft.state.picks.length,
    teams: window.__draft.E.LEAGUE.teams,
    snake: window.__draft.E.seatForPick(11)                // round 2 opens with seat 10
  }));
  expect(s.picks).toBe(0);
  expect(s.teams).toBe(10);
  expect(s.snake).toBe(10);
  await expect(page.locator("#bReal")).toBeHidden();
  await expect(page.locator("#bPrev")).toBeHidden();
});

test("settings: 6-point passing TDs lift every quarterback", async ({ page }) => {
  const before = await page.evaluate(() =>
    window.__draft.players.find((p) => p.name === "Josh Allen").proj);
  await page.click("#bSettings");
  await page.fill("#pPassTD", "6");
  await page.click("#bSaveSettings");
  const after = await page.evaluate(() =>
    window.__draft.players.find((p) => p.name === "Josh Allen").proj);
  expect(after).toBeGreaterThan(before * 1.1);
});

test("settings: a league without K/D-ST slots never wants either", async ({ page }) => {
  await page.click("#bSettings");
  await page.fill("#stK", "0");
  await page.fill("#stDST", "0");
  await page.click("#bSaveSettings");
  const r = await page.evaluate(() => {
    const E = window.__draft.E;
    return {
      needK: E.needMultiplier("K", E.emptyCounts(), 16, { K: 12 }),
      forcedK: E.forcedBonus("K", E.emptyCounts(), 1, { K: 3 }),
      starters: E.LEAGUE.starterCount,
      slots: E.buildLineup([]).filter((s) => s.slot === "K" || s.slot === "D/ST").length
    };
  });
  expect(r.needK).toBe(0);
  expect(r.forcedK).toBe(0);
  expect(r.starters).toBe(7);
  expect(r.slots).toBe(0);
});

test("settings persist across a reload", async ({ page }) => {
  await page.click("#bSettings");
  await page.fill("#sName", "Test League");
  await page.selectOption("#sFormat", "half");
  await page.click("#bSaveSettings");
  await page.reload();
  await page.waitForFunction(() => !!window.__draft);
  await expect(page.locator(".stat.brand .l")).toHaveText("Test League");
  const cfg = await page.evaluate(() => window.__draft.E.getConfig());
  expect(cfg.name).toBe("Test League");
  expect(cfg.format).toBe("half");
});

test("settings: half PPR swaps the ranking set without touching picks", async ({ page }) => {
  await page.locator("#poolBody tr.row").first().click();          // Team 1 takes Gibbs
  const before = await page.evaluate(() => ({
    henry: window.__draft.players.find((p) => p.name === "Derrick Henry").rank,
    bowers: window.__draft.players.find((p) => p.name === "Brock Bowers").rank
  }));
  await page.click("#bSettings");
  await page.selectOption("#sFormat", "half");
  await page.click("#bSaveSettings");
  const after = await page.evaluate(() => {
    const d = window.__draft;
    return {
      henry: d.players.find((p) => p.name === "Derrick Henry").rank,
      bowers: d.players.find((p) => p.name === "Brock Bowers").rank,
      rec: d.E.LEAGUE.points.rec,
      picks: d.state.picks.length,
      first: d.players.find((p) => p.id === d.state.picks[0].playerId).name
    };
  });
  // half PPR lifts the volume back, drops the pass-catching tight end
  expect(after.henry).toBeLessThan(before.henry);
  expect(after.bowers).toBeGreaterThan(before.bowers);
  expect(after.rec, "reception value follows the format").toBe(0.5);
  expect(after.picks).toBe(1);
  expect(after.first).toBe("Jahmyr Gibbs");
});

test("your seat drives the header and the default roster", async ({ page }) => {
  await expect(page.locator("#sNext")).toHaveText("#6 (5 away)");
  await expect(page.locator("#rosterTitle")).toHaveText("You (6)");
  await page.click("#bAuto");
  await expect(page.locator("#sNext")).toHaveText("#6 (4 away)");
  await expect(page.locator("#rosterTitle")).toHaveText("You (6)");   // roster stays yours
});

test("changing your seat in settings retargets the product", async ({ page }) => {
  await page.click("#bSettings");
  await page.fill("#sSeat", "1");
  await page.click("#bSaveSettings");
  await expect(page.locator("#sNext")).toHaveText("#1");              // on the clock right now
  await expect(page.locator("#sClockV")).toHaveText("You (1)");
  await expect(page.locator("#rosterTitle")).toHaveText("You (1)");
  await expect(page.locator("#leagueSub")).toContainText("you are seat 1");
});

test("clicking a team card inspects its roster, clicking again returns to yours", async ({ page }) => {
  await page.locator('#teams .tm[data-seat="4"]').click();
  await expect(page.locator("#rosterTitle")).toHaveText("Team 4");
  await expect(page.locator("#rosterSub")).toContainText("pinned");
  await page.locator('#teams .tm[data-seat="4"]').click();
  await expect(page.locator("#rosterTitle")).toHaveText("You (6)");
});

test("settings: half PPR ranks off the half-PPR sources, and reverts cleanly", async ({ page }) => {
  const ppr = await page.evaluate(() =>
    window.__draft.players.slice(0, 60).map((p) => p.name).join("|"));
  await page.click("#bSettings");
  await page.selectOption("#sFormat", "half");
  await page.click("#bSaveSettings");
  const r = await page.evaluate(() => {
    const P = window.__draft.players;
    // every player carrying half-PPR data must outrank one that has none but
    // sits deeper on both boards — i.e. the half set is really driving order
    const covered = P.filter((p) => p.srcHalf && p.pos !== "DST" && p.pos !== "K");
    return {
      order: P.slice(0, 60).map((x) => x.name).join("|"),
      covered: covered.length,
      rb1: P.filter((x) => x.pos === "RB")[0].name
    };
  });
  expect(r.covered).toBeGreaterThan(150);
  expect(r.order).not.toBe(ppr);
  expect(r.rb1).toBe("Jahmyr Gibbs");
  await page.click("#bSettings");
  await page.selectOption("#sFormat", "ppr");
  await page.click("#bSaveSettings");
  const back = await page.evaluate(() =>
    window.__draft.players.slice(0, 60).map((p) => p.name).join("|"));
  expect(back, "toggling back restores the full-PPR board exactly").toBe(ppr);
});

test("settings shows the blend behind the board and swaps it with the format", async ({ page }) => {
  await page.click("#bSettings");
  await expect(page.locator("#srcFor")).toHaveText("· full PPR");
  const ppr = await page.locator("#srcWeights .sname").allInnerTexts();
  expect(ppr[0]).toBe("Market ADP");                       // heaviest source first
  expect(ppr).toContain("ESPN");
  await expect(page.locator("#srcWeights .sval").first()).toHaveText("35%");
  await page.selectOption("#sFormat", "half");             // updates live, before saving
  await expect(page.locator("#srcFor")).toHaveText("· half PPR");
  const half = await page.locator("#srcWeights .sname").allInnerTexts();
  expect(half).toEqual(["Market ADP", "FFC board", "RotoWire"]);
  await expect(page.locator("#srcNote")).toContainText("fixed for now");
});
