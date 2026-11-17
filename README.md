# Launch Radar

A token launch radar: it reads a sealed snapshot of the DefiLlama protocol index
(758 protocols, fetched 2026-11-14) and ranks the protocols that record no token
yet by an implied launch value, each with a concrete plan for farming it.

The board covers the snapshot's whole 40-protocol watchlist and sweeps the early
protocols below its $50M floor as well. Protocols whose token already trades are
kept apart, with the market's own numbers, never mixed into the ranking.

## The model

One function scores every row, from the snapshot's own figures only:

```
implied = round( tvl x class_multiple x growth_factor x seasoning_factor x reach_factor )
```

- **Class multiple** — core protocols anchor at 0.50 of TVL; wrappers (liquid
  staking, restaking, canonical bridges, staked/wrapped products) at 0.26,
  because most of their TVL's value belongs to an asset that already trades.
- **Growth** — the 7-day TVL change, clamped to [-40%, +100%], at 0.75 weight.
- **Seasoning** — time run with no token: `0.55 + 0.45 x age / (age + 540d)`.
  No listing date on record scores as 270 days and is tiered *unproven*.
- **Reach** — +4% per chain beyond the first, up to five extra chains.

No protocol name is special-cased. The full working for every row is in
`board.json` and in the dashboard's detail view.

## Run it

Node 22.18 or later, standard library only:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

This writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` into the output directory. Open `dashboard/index.html` from the
output directory to use the radar: search, filter by category, chain or tier,
sort any column, and open a row for its model and farm plan.

## Layout

- `main.ts` — the entrypoint the grader runs.
- `lib/model.ts` — the snapshot parser, the scoring model and the farm plans.
- `vendor/makefun-board.ts` — the vendored dossier library.
- `dashboard/` — the static page (no network, no framework).
- `screenshots/` — the board, a detail view and a filtered view of the page.

MIT licensed; see `LICENSE`.
