# Draft Room

A draft board. Default configuration: **12 teams, full PPR, snake** — every bit
of it (teams, seat, roster shape, scoring, ranking weights) adjustable in Settings. You log every pick as it happens, and it tells you who to take.

```bash
./start.sh          # serves on 127.0.0.1:8777 and opens the browser
npm test            # 24 Playwright tests
```

Nothing leaves your machine and there is no build step. Your draft is saved to
browser storage as you go, so you can reload mid-draft without losing anything.

## Using it during the draft

| Action | How |
|---|---|
| Log any pick | Click the player's row — he goes to whoever is on the clock |
| Log a pick fast | `/` to focus search, type a few letters, `Enter` |
| Someone took a player not on this board | **Log unknown** (keeps the clock in sync) |
| A player is missing entirely | Add name + position + team at the bottom of the pool |
| Mistake | **Undo**, or `u` |
| Try a scenario | **Sim to my pick** fills the other 11 teams with a bot |

The top panel is always *your* board, even when it is someone else's turn, so
you can see what is likely to survive to your next pick.

## How the recommendation works

Five steps, in order:

1. **Projection.** Each player gets a season projection under this league's
   scoring from a curve fitted to his rank within his position. These are my
   estimates derived from the consensus rank order, not a published projection
   set.
2. **Value over replacement.** Subtract what you could get for free off waivers.
   The RB and WR baselines are set at RB32 / WR34 because the FLEX absorbs about
   six extra of each across a 12-team league.
3. **Positional correction.** Raw VOR overrates positions you can only start one
   of. Quarterbacks are scaled to 0.62 and tight ends to 0.90; kickers and
   defenses are scaled hard because they are streamable week to week.
4. **Survival.** A 400-run Monte Carlo of the picks between now and your next
   turn tells you the odds each player is still on the board. That drives both
   the "still there" column and the urgency term — a player only earns a bonus
   for being scarce if he is genuinely unlikely to last.
5. **Roster fit.** Your unfilled slots scale everything, and a bye-week pileup
   applies a small penalty (a nudge, never a veto).

### Two things the engine gets right that a plain ranking does not

**Marginal value bottoms out at zero.** A player worse than replacement has
negative VOR, and a negative number times a positive need is still negative —
which ranked every late bench flier *below* a kicker and drained the kicker
shelf by pick 113. Value is floored at zero, and board rank breaks the ties.

**Empty starting slots become mandatory on supply, not on round number.** All
twelve managers want exactly one kicker and this board carries ten, so the shelf
can empty two rounds before "the last round". The forced fill triggers when
either you are out of spare picks *or* the shelf for a position you still need
is nearly bare. Before that fix, seat 6 finished without a quarterback in about
one draft in eight.

Left to its own devices across 240 simulated drafts it takes a QB in round 8, a
TE in round 8, a kicker in round 14 and a defense in round 15 — and never once
left a starting slot empty.

## Known limits

- **The board is 186 players deep and the draft is 192 picks.** The tail is
  logged as off-board picks. In a real draft this never bites, because the other
  managers will be taking deep names that were never on the board anyway — that
  is what **Log unknown** is for.
- **Ten kickers, twelve managers.** ESPN ranks ten; two teams mathematically
  cannot have one. The engine prioritises the kicker in the forced fill so that
  seat 6 is not one of them. Add any kicker you like with the pool form.
- **Rankings are a snapshot from Aug 23, 2026.** Check the injury flags against
  the wire before you submit a pick — Nacua, Egbuka, Jeremiyah Love, Hubbard and
  Burden were all unresolved.
- **The bot is not your league.** It drafts on value and need with noise. Use it
  to pressure-test a scenario, not to predict what Team 4 will actually do.

## Files

| | |
|---|---|
| `data.js` | 186 players: rank, position, team, tier, notes, injury flags |
| `engine.js` | Projections, VOR, survival simulation, recommendation. No DOM. |
| `app.js` | State, rendering, keyboard handling, persistence |
| `tests/draft.spec.js` | 24 Playwright tests |

`engine.js` runs under Node as well as the browser, so the scoring model can be
tested without a page.

## Sources

Blended from [ESPN / Field Yates PPR top 160 (Aug 21)](https://www.espn.com/fantasy/football/story/_/id/48711830/2026-fantasy-football-rankings-ppr-field-yates),
[Bleacher Report top 100 PPR](https://bleacherreport.com/articles/25458550-top-100-fantasy-football-rankings-ppr-leagues-2026),
[FantasyPros ADP risers and fallers](https://www.fantasypros.com/2026/08/30-fantasy-football-adp-risers-fallers-2026/),
[ESPN sleepers, breakouts and busts](https://www.espn.com/fantasy/football/story/_/page/FFSleepBustBreak26-49030808/fantasy-football-2026-rankings-nfl-sleepers-breakouts-busts),
[Yahoo camp injury tracker](https://sports.yahoo.com/fantasy/article/nfl-training-camp-injury-report-tracking-the-latest-news-updates-for-2026-fantasy-football-163938278.html)
and [NFL.com 2026 bye weeks](https://www.nfl.com/news/2026-nfl-schedule-release-every-team-bye-week).

## Reviewing a recorded draft (optional plugin)

`replay.js` is a private, gitignored plugin: one league's recorded picks plus
the UI for stepping through them. The core app has no replay code — it exposes
two hooks (`teamName`, `afterRender`) and the plugin injects its own buttons,
banner, and styles. Without the file, none of this exists. With it:

- **Load real draft** — loads every pick so you can see all 12 rosters.
- **◀ Pick / Pick ▶** — steps the recorded draft one pick at a time; every pick
  shows the tool's top 5 next to what that team actually took.
- **Log that pick** — logs the recorded pick and moves on.

`node -e 'require("./engine.js")'` style replays are in `tests/draft.spec.js`.

## Board order: one ranking set per scoring format

Every skill player carries two sets of source ranks in `data.js`:

- **8th field, full PPR** — market ADP (FantasyFootballCalculator PPR, ~7.8k
  drafts), RotoWire expert consensus, PFN top 200, CBS top 140, ESPN draft-day
  rank, and this board's hand-tuned August order.
- **9th field, half PPR** — FFC half-PPR ADP (~2.9k drafts), FFC's half-PPR
  board, RotoWire half-PPR. Coverage runs ~200 deep; past that a player falls
  back to his full-PPR blend.

The **Receptions** setting picks the set, so it moves the board *and* the
projections together (half PPR: Derrick Henry 16 → 10, Brock Bowers 26 → 36).
Each set is a weighted average renormalized over whichever sources cover the
player; the weights live in `SOURCE_WEIGHTS` in `engine.js` and are not yet
exposed in the UI. Player ids are stable, so switching format never disturbs
logged picks.

## Deploying

Static frontend only — three script files, one stylesheet, state in
`localStorage`. No backend, no build step.

**Vercel**: push this directory to a Git repo, import it in Vercel, framework
preset "Other", no build command, output directory `./`. Or from this
directory: `npx vercel`.

Note before publishing: `replay.js` contains one real league's complete 2026
draft (team names included) as the built-in replay.

