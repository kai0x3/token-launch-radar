// Launch Radar model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The question the board answers: if this protocol issued its token today and its record stayed
// exactly as the snapshot shows it, what would that token plausibly be worth, and what should a
// reader do on the protocol, starting now, to be counted if it ever does? The board never claims
// a token is coming. It ranks protocols that record no token yet by an implied value derived only
// from the snapshot's own figures, and it sets the protocols whose token already trades apart,
// with the market's own numbers, so the two are never mixed.
//
//   implied = round( tvl_usd x class_multiple x growth_factor x seasoning_factor x reach_factor )
//
// - class_multiple anchors value to TVL. A core protocol (a lending market, a DEX, a curator) is
//   anchored at 0.50 of TVL: live governance tokens of record-holding protocols change hands
//   around that order of magnitude. A wrapper protocol (liquid staking, restaking, a canonical
//   bridge: a claim on another asset whose own token already trades) is anchored lower, at 0.26,
//   because most of the value its TVL represents belongs to the underlying asset's ecosystem.
// - growth_factor reads the seven-day TVL change, clamped to [-40, +100] percent so one wild
//   week cannot dominate, and scales it by 0.75: momentum counts, at three-quarter weight.
// - seasoning_factor rewards time survived with no token: 0.55 + 0.45 x age / (age + 540 days).
//   It starts at 0.55, passes 0.775 at eighteen months and approaches 1. A protocol DefiLlama
//   gives no listing date for is scored as 270 days old and labelled unproven.
// - reach_factor adds 4% per extra chain beyond the first, capped at five extra chains: a
//   protocol already live on several chains has the distribution a launch needs.
//
// No protocol name is ever special-cased: class, tier and every factor come from the row's own
// category, chains, TVL, growth and listing date, and one function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard so a reader can re-run the arithmetic. */
export interface ModelConstants {
  core_multiple: number;
  wrapper_multiple: number;
  growth_weight: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  seasoning_base: number;
  seasoning_span: number;
  seasoning_mid_days: number;
  unknown_age_days: number;
  reach_per_chain: number;
  reach_max_extra_chains: number;
}

export const MODEL: ModelConstants = {
  core_multiple: 0.5,
  wrapper_multiple: 0.26,
  growth_weight: 0.75,
  growth_floor_pct: -40,
  growth_cap_pct: 100,
  seasoning_base: 0.55,
  seasoning_span: 0.45,
  seasoning_mid_days: 540,
  unknown_age_days: 270,
  reach_per_chain: 0.04,
  reach_max_extra_chains: 5,
};

/** The model's version label: the dashboard names it and the board's rows carry it. */
export const MODEL_VERSION = 'launch-radar-2';

/** The board's size cap: every watchlist row plus the strongest early rows under it. */
export const BOARD_CAP = 340;

/** How many live-token protocols the dashboard's Already trading view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A wrapper of an asset that already trades, or a core protocol standing on its own record. */
export type AssetClass = 'core' | 'wrapper';

/** How long a protocol has run with no token, in words a reader can act on. */
export type Tier = 'established' | 'seasoned' | 'young' | 'new' | 'unproven';

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  asset_class: AssetClass;
  tier: Tier;
  age_days: number | null;
  implied_value_usd: number;
  fdv_tvl: number;
  model: {
    class_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    seasoning_multiplier: number;
    reach_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: the row itself, farm plan included, nothing hidden. */
export interface RadarRow extends BoardRow {}

/** A live-token protocol: it already trades, so the dashboard shows the market's value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

/** Everything the dashboard needs: the board, the live set apart, and the model that scored it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  protocols_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  live_total: number;
  board_implied_total_usd: number;
  watchlist: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of an asset that already trades. */
const WRAPPER_WORD = /\b(wrapped|staked|staking)\b/i;

/** Categories whose TVL is a claim on another protocol's asset rather than the protocol's own. */
const WRAPPER_CATEGORIES = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Canonical Bridge']);

/** Exchange names: a protocol whose name begins with one is that exchange's product, not a launch. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol's asset class, from its category and name alone. */
export function assetClass(p: SnapshotProtocol): AssetClass {
  if (p.category !== null && WRAPPER_CATEGORIES.has(p.category)) return 'wrapper';
  if (WRAPPER_WORD.test(p.name)) return 'wrapper';
  if (EXCHANGE_PREFIX.test(p.name)) return 'wrapper';
  return 'core';
}

/** A protocol's tier, from how long it has run with no token. */
export function tierOf(age: number | null): Tier {
  if (age === null) return 'unproven';
  if (age >= 730) return 'established';
  if (age >= 365) return 'seasoned';
  if (age >= 120) return 'young';
  return 'new';
}

/** Whether the board may rank a protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The factors one protocol gets under `model`, and the implied value they multiply to. */
export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  model: ModelConstants = MODEL,
): { implied: number; cls: AssetClass; tier: Tier; age: number | null; growthPct: number; growthMult: number; seasoningMult: number; reachMult: number; multiple: number } {
  const age = ageDays(asOf, p.listed_at);
  const cls = assetClass(p);
  const multiple = cls === 'wrapper' ? model.wrapper_multiple : model.core_multiple;
  const growthPct = Math.min(model.growth_cap_pct, Math.max(model.growth_floor_pct, finite(p.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const seasoningMult = model.seasoning_base + model.seasoning_span * (ageForModel / (ageForModel + model.seasoning_mid_days));
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), model.reach_max_extra_chains);
  const reachMult = 1 + model.reach_per_chain * extraChains;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * seasoningMult * reachMult));
  return { implied, cls, tier: tierOf(age), age, growthPct, growthMult, seasoningMult, reachMult, multiple };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 120;
  if (p.tvl_usd >= 50_000_000) return 80;
  return 50;
}

/** How long to hold, from the protocol's tier: the younger the record, the longer the window. */
function holdDaysFor(tier: Tier): number {
  if (tier === 'established') return 30;
  if (tier === 'seasoned') return 45;
  if (tier === 'young') return 60;
  return 75;
}

/** Gas for one round of actions, from the size of the position. */
function gasFor(capital: number): number {
  if (capital >= 200) return 10;
  if (capital >= 120) return 7;
  return 4;
}

/**
 * The two protocol actions of a farm plan, from the protocol's category: the entry action that
 * puts capital to work, and the second action that makes the wallet look like a real user of the
 * protocol rather than a parked deposit. Both name the protocol, its first chain and the capital.
 */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): [string, string] {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return [
      `Supply $${capital} of USDC as collateral to ${name} on ${chain} and leave the position open.`,
      `Borrow about 30% of the supplied value against it, hold the borrowed funds for a week, then repay in full.`,
    ];
  }
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual')) {
    return [
      `Provide $${capital} of liquidity to ${name}'s busiest pool on ${chain} and leave the position open.`,
      `Make one small swap a week through ${name} itself, in the same pool, so the wallet trades as well as provides.`,
    ];
  }
  if (c.includes('bridge')) {
    return [
      `Bridge $${capital} of USDC from Ethereum to ${chain} through ${name} and keep the bridged funds working there.`,
      `Bridge about a quarter of it back a week later, so the wallet crosses in both directions like a real user.`,
    ];
  }
  if (c.includes('staking') || c.includes('restak') || c.includes('staking pool')) {
    return [
      `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the staking receipt in the wallet.`,
      `Claim the staking rewards once they accrue and restake them, so the position compounds on its own record.`,
    ];
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) {
    return [
      `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the wallet.`,
      `Move a small part of the position to a second ${name} vault after two weeks, so the wallet uses more than one strategy.`,
    ];
  }
  if (c.includes('basis')) {
    return [
      `Open the $${capital} basis position ${name} offers on ${chain}, with the hedge leg exactly as its app sets it.`,
      `Rebalance the hedge once after the first week and keep both legs open for the rest of the hold.`,
    ];
  }
  if (c.includes('rwa') || c.includes('stable')) {
    return [
      `Mint $${capital} of ${name}'s asset on ${chain} with USDC and hold the minted asset in the wallet.`,
      `Use the minted asset once in a supported market, a swap or a collateral deposit, then return it to the wallet.`,
    ];
  }
  if (c.includes('prediction')) {
    return [
      `Fund $${capital} on ${name} and take one position in its most liquid market.`,
      `Settle or roll that position at expiry and take one more, so the wallet has a record across two markets.`,
    ];
  }
  if (c.includes('insurance')) {
    return [
      `Buy $${capital} of cover from ${name} on ${chain} for a position you actually hold, and keep the policy.`,
      `Stake a small amount into ${name}'s capital pool as well, so the wallet stands on both sides of the market.`,
    ];
  }
  return [
    `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`,
    `Use one more of ${name}'s own features in the second week, a second deposit, a vote or a claim, and keep the receipt.`,
  ];
}

/** A step as one string: its action, then its cost and its time, inside the gate's 20..600 characters. */
export function stepText(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page weekly.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with what it costs and how long it takes.
 * The plan is derived from the protocol's own record (category, chains, TVL, tier), never from a
 * hand-written list of names, so the same derivation writes every row of the board.
 */
export function farmSteps(p: SnapshotProtocol, tier: Tier): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(capital);
  const hold = holdDaysFor(tier);
  const [entry, second] = actionsFor(p, capital, chain);
  const raw: Array<[string, string, string]> = [
    [
      `Set up a fresh wallet for this farm alone, fund it from your main wallet, and keep its seed phrase offline on paper.`,
      'under $3 of gas to fund it',
      '5 minutes',
    ],
    [entry, `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'],
    [second, 'about $3 of gas', '10 minutes'],
    [
      `Repeat one qualifying action every week, a deposit, a swap, a vote or a claim, so the wallet reads as an active user.`,
      'about $2 of gas a week',
      '10 minutes a week',
    ],
    [
      `Hold the position for at least ${hold} days, so the activity lands in more than one weekly snapshot of the protocol.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ],
    [
      `Cap your total exposure at the plan's $${capital}: check the protocol's own docs and audit page before adding more, and never farm with borrowed money.`,
      'nothing to check',
      '10 minutes',
    ],
    [
      `When you finish, open the protocol's own points or rewards page, claim only from the link it publishes, then unwind the position in two parts a day apart.`,
      'about $4 of gas to unwind',
      '15 minutes',
    ],
  ];
  return raw.map(([a, c, t]) => stepText(a, c, t));
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug is on the board, whatever the model thinks of it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol below the floor, strongest implied
  // value first, until the board's cap. The radar exists to find these before they reach it.
  // Above the floor the board ranks the watchlist alone: the house built that list with
  // DefiLlama's parent-protocol records, which the snapshot does not carry, so it is the only
  // above-floor set screened of wrapped, staked and bridged products of tokens that already
  // trade (WBTC, USDT0 and their kin sit above the floor and off the list for exactly that
  // reason, and no field in the snapshot would catch them). Below the floor no product can
  // headline a board, and the field-derivable part of the same screen (not an exchange, not a
  // versioned pool, wrappers discounted) is applied by isRankable and assetClass instead.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, model) }))
    .sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  for (const { p } of early) {
    if (chosen.size >= BOARD_CAP) break;
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token' as const,
    asset_class: s.cls,
    tier: s.tier,
    age_days: s.age,
    implied_value_usd: s.implied,
    fdv_tvl: round4(s.implied / p.tvl_usd),
    model: {
      class_multiple: s.multiple,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      seasoning_multiplier: round4(s.seasoningMult),
      reach_multiplier: round4(s.reachMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.tier),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Already trading view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      symbol: p.symbol,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const liveTotal = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX').length;
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    protocols_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watch.has(r.slug)).length,
    live_size: live.length,
    live_total: liveTotal,
    board_implied_total_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    watchlist: [...snapshot.watchlist],
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
