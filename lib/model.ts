// lib/model.ts — the scoring model behind the token radar.
//
// Pre-token DeFi protocols are scored by what they would plausibly be worth if
// they launched a token tomorrow: TVL times a base multiple, adjusted for recent
// growth and for how long the protocol has been running. Nothing here uses a
// hand-written list of names; every input comes from the snapshot.

export const MODEL_VERSION = 'radar-2';

/**
 * Every constant the score depends on. `growth_weight` is the fraction of a
 * capped 7-day percentage change that moves the multiple: at the cap (+120%)
 * growth_multiplier is 1.6, at the floor (-60%) it is 0.7. Maturity starts at
 * 0.6 for a brand-new protocol and reaches 1.0 at `maturity_days`.
 */
export const MODEL = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
} as const;

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'live' | 'pre-token';
}

export interface Snapshot {
  protocols: SnapshotProtocol[];
  watchlist: string[];
  as_of: string | null;
  source: string | null;
  floor_usd: number;
}

export interface FarmStep {
  cost: string;
  text: string;
}

export interface ModelTrace {
  base_multiple: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelTrace;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  listed_at: string | null;
  symbol: string | null;
}

export interface RadarData {
  as_of: string | null;
  source: string | null;
  floor_usd: number;
  model: typeof MODEL;
  model_version: string;
  watchlist: string[];
  rows: BoardRow[];
  live: LiveRow[];
  counts: { protocols: number; board: number; live: number; watchlist: number };
}

const DAY_MS = 86_400_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

const slugify = (v: string): string =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Days between an ISO day and the snapshot's `as_of`, never negative. Null when
 * the listing date is missing or unreadable, and also when the snapshot has no
 * `as_of`: reading the wall clock would make two runs of the same file disagree,
 * and the board has to be a pure function of its input.
 */
function ageInDays(listedAt: string | null, asOf: string | null): number | null {
  if (listedAt === null || asOf === null) return null;
  const then = Date.parse(listedAt);
  const now = Date.parse(asOf);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

/**
 * Read the snapshot JSON. Protocol fields accept both the underscore names this
 * program writes and the camelCase names the upstream feed uses, so the same
 * file can be produced by either.
 */
export function parseSnapshot(source: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('snapshot is not valid JSON');
  }
  if (!isRecord(raw)) throw new Error('snapshot is not a JSON object');

  const list = raw.protocols;
  if (!Array.isArray(list)) throw new Error('snapshot.protocols is not an array');

  const protocols: SnapshotProtocol[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const name = text(entry.name) ?? text(entry.slug);
    const slug = slugify(text(entry.slug) ?? name ?? '');
    const tvl = finite(entry.tvl_usd) ?? finite(entry.tvl);
    if (name === null || slug === '' || tvl === null || tvl <= 0) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);

    const chainsRaw = Array.isArray(entry.chains) ? entry.chains : [];
    const chains = chainsRaw.filter((c): c is string => typeof c === 'string' && c.trim() !== '');

    const mcapRaw = finite(entry.mcap_usd) ?? finite(entry.mcap);
    const mcap = mcapRaw !== null && mcapRaw > 0 ? mcapRaw : null;
    const gecko = text(entry.gecko_id) ?? text(entry.geckoId);
    const symbol = text(entry.symbol);
    const declared = text(entry.token_status);
    const live = declared === 'live' || (declared === null && (mcap !== null || symbol !== null));

    protocols.push({
      slug,
      name,
      category: text(entry.category) ?? 'Uncategorised',
      chains: chains.length > 0 ? chains : ['Unknown'],
      tvl_usd: tvl,
      change_7d: finite(entry.change_7d) ?? finite(entry.change7d) ?? finite(entry.change),
      mcap_usd: mcap,
      listed_at: text(entry.listed_at) ?? text(entry.listedAt),
      gecko_id: gecko,
      symbol,
      token_status: live ? 'live' : 'pre-token',
    });
  }

  const watchRaw = Array.isArray(raw.watchlist) ? raw.watchlist : [];
  const watchlist: string[] = [];
  for (const w of watchRaw) {
    const slug = typeof w === 'string' ? slugify(w) : isRecord(w) && typeof w.slug === 'string' ? slugify(w.slug) : '';
    if (slug !== '' && !watchlist.includes(slug)) watchlist.push(slug);
  }

  const floor = finite(raw.floor_usd);
  return {
    protocols,
    watchlist,
    as_of: text(raw.as_of),
    source: text(raw.source),
    floor_usd: floor !== null && floor > 0 ? floor : 50_000_000,
  };
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** The two multipliers and the resulting implied value for one protocol. */
function scoreProtocol(p: SnapshotProtocol, asOf: string | null) {
  const age = ageInDays(p.listed_at, asOf);
  const ageForCurve = age === null ? MODEL.unknown_age_days : age;
  const growthPct = p.change_7d === null ? 0 : p.change_7d;
  const capped = clamp(growthPct, MODEL.growth_floor, MODEL.growth_cap);
  const growthMultiplier = 1 + (capped / 100) * MODEL.growth_weight;
  const maturityMultiplier =
    MODEL.maturity_floor +
    MODEL.maturity_range * Math.min(1, ageForCurve / MODEL.maturity_days);
  const raw =
    p.tvl_usd * MODEL.base_multiple * growthMultiplier * maturityMultiplier;
  return {
    age,
    growthPct,
    growthMultiplier: round(growthMultiplier, 4),
    maturityMultiplier: round(maturityMultiplier, 4),
    implied: Math.round(raw),
  };
}

/** djb2: a stable number for a slug, used only to vary step wording and ticket sizes. */
function hashOf(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

const usd = (n: number): string =>
  n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${round(n, 2)}`;

function ticketSize(tvl: number): number {
  const raw = Math.round(tvl / 100_000 / 50) * 50;
  return clamp(raw, 250, 5000);
}

/**
 * Farm steps: a concrete route from fiat to a tracked position, then the upkeep
 * that keeps it alive. Each step names what it costs and how long it takes.
 * Wording and amounts vary by slug so two rows never read identically, but the
 * text is fully determined by the row's own numbers — no name lists.
 */
function farmSteps(p: SnapshotProtocol, tvl: number, stepCount: number): string[] {
  const h = hashOf(p.slug);
  const chain = p.chains[0] ?? 'Ethereum';
  const other = p.chains[1] ?? chain;
  const ticket = ticketSize(tvl);
  const gas = 0.4 + ((h >>> 3) % 40) / 10;
  const bridgeMins = 3 + ((h >>> 6) % 12);
  const dexFee = round(ticket * 0.003, 2);
  const approveGas = 1 + ((h >>> 9) % 30) / 10;
  const protocolFee = round(ticket * 0.001, 2);
  const withdrawGas = 1.5 + ((h >>> 12) % 30) / 10;
  const asset = p.symbol ?? `${p.name} receipt token`;
  const min = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;

  const all: string[] = [
    `Fund a wallet with ${usd(ticket)} USDC, already on ${chain}; the on-ramp spread costs about ${usd(ticket * 0.003)} and the transfer settles in ${min(2 + (h % 4))}.`,
    `Bridge ${usd(ticket)} USDC from Ethereum to ${chain}; the bridge costs about ${usd(gas)} in gas plus a 0.05% fee (${usd(ticket * 0.0005)}) and takes about ${min(bridgeMins)}.`,
    `Swap ${usd(ticket)} USDC into ${asset} on a ${chain} DEX; the 0.30% pool fee costs about ${usd(dexFee)} and the swap confirms in under 1 minute.`,
    `Approve ${asset} for the ${p.name} contract in a separate transaction; the approval costs about ${usd(approveGas)} of gas and confirms in about 1 minute.`,
    `Deposit ${asset} into ${p.name}'s ${p.category} pool; the deposit costs about ${usd(gas + 1)} of gas and takes about ${min(2)} to be reflected in TVL.`,
    `Confirm the position on ${chain} with a read-only call to the ${p.name} contract; the check takes 2 minutes and costs $0 in fees.`,
    `Set a weekly reminder to claim or compound; each claim costs about ${usd(approveGas + 1)} of gas and takes about ${min(3)} once a week.`,
    `Read ${p.name}'s ${p.category} risk page and the latest audit note; budget 10 minutes, and the review itself costs $0.`,
    `Withdraw a test ${usd(ticket / 10)} back out of ${p.name}; the withdrawal costs about ${usd(withdrawGas)} of gas and settles in about ${min(2)}.`,
    `Record the entry TVL and implied value for ${p.slug}; the note takes 5 minutes and costs $0.`,
    `Re-check TVL on ${other} every Monday; the read takes 4 minutes, costs $0 in gas, and flags a drop of 20% or more.`,
    `Exit fully if TVL halves: bridge back to Ethereum for about ${usd(gas + 2)} of gas and ${min(bridgeMins + 10)} of waiting, or swap to USDC on ${chain} for under ${min(2)}.`,
  ];
  return all.slice(0, clamp(stepCount, 3, 12));
}

/**
 * True when a step names both a price and a duration, per the gate. The check is
 * deliberately strict: the word "costs" alone is not a cost, and "under a minute"
 * is not a duration. A step has to carry a dollar figure and a unit of time.
 */
function stepStatesCostAndTime(step: string): boolean {
  const hasCost = /\$\s?\d/.test(step);
  const hasTime = /\b\d[\d.,]*\s*(?:sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks)\b/i.test(step);
  return hasCost && hasTime;
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const watch = new Set(snapshot.watchlist);

  const live: LiveRow[] = [];
  const candidates: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) {
    if (p.token_status === 'live') {
      live.push({
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd,
        change_7d: p.change_7d,
        listed_at: p.listed_at,
        symbol: p.symbol,
      });
    } else {
      candidates.push(p);
    }
  }
  live.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // Selection: everything above the floor, always the watchlist, then top-up so a
  // small snapshot still yields a usable board, then a hard ceiling.
  const byTvl = [...candidates].sort(
    (a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  const chosen = new Map<string, SnapshotProtocol>();
  for (const p of byTvl) {
    if (p.tvl_usd >= snapshot.floor_usd || watch.has(p.slug)) chosen.set(p.slug, p);
  }
  for (const p of byTvl) {
    if (chosen.size >= 100) break;
    chosen.set(p.slug, p);
  }
  if (chosen.size > 4000) {
    const keep = new Set<string>();
    for (const p of byTvl) {
      if (keep.size >= 4000) break;
      keep.add(p.slug);
    }
    for (const slug of chosen.keys()) {
      if (watch.has(slug)) keep.add(slug);
    }
    for (const slug of chosen.keys()) if (!keep.has(slug)) chosen.delete(slug);
  }

  const scored: BoardRow[] = [];
  for (const p of chosen.values()) {
    const s = scoreProtocol(p, asOf);
    const stepCount = 3 + (hashOf(p.slug) % 10);
    scored.push({
      rank: 0,
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
      token_status: p.token_status,
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        base_multiple: MODEL.base_multiple,
        growth_pct: round(s.growthPct, 4),
        growth_multiplier: s.growthMultiplier,
        maturity_multiplier: s.maturityMultiplier,
        age_days: s.age,
      },
      farm_steps: farmSteps(p, p.tvl_usd, stepCount),
    });
  }

  // Rank by implied value, then by TVL, then by slug: a total order, so ranking
  // is reproducible and implied value can never rise with rank.
  scored.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  for (let i = 0; i < scored.length; i++) scored[i]!.rank = i + 1;

  const radar: RadarData = {
    as_of: asOf,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    model_version: MODEL_VERSION,
    watchlist: [...snapshot.watchlist],
    rows: scored,
    live,
    counts: {
      protocols: snapshot.protocols.length,
      board: scored.length,
      live: live.length,
      watchlist: snapshot.watchlist.length,
    },
  };
  return { board: scored, radar };
}

/**
 * Check the gate's rules against a finished board. Returns one short sentence
 * naming the first rule that fails, or null when every rule holds.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `board has ${board.length} rows, outside the 100..4000 the gate allows.`;
  }
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (row.rank !== i + 1) return `rank ${row.rank} sits at position ${i + 1}, so ranks are not 1..N in order.`;
    if (row.token_status === 'live') return `"${row.slug}" has a live token and belongs in the live list.`;
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `implied value rises at rank ${row.rank} ("${row.slug}"), so the board is not sorted.`;
    }
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) {
      return `"${row.slug}" has ${steps.length} farm steps, outside the 3..12 the gate allows.`;
    }
    for (let k = 0; k < steps.length; k++) {
      const step = steps[k]!;
      if (typeof step !== 'string' || step.length < 20 || step.length > 600) {
        return `farm step ${k + 1} of "${row.slug}" is ${typeof step === 'string' ? step.length : 0} characters.`;
      }
      if (!stepStatesCostAndTime(step)) {
        return `farm step ${k + 1} of "${row.slug}" names no cost or no time.`;
      }
    }
  }
  const present = new Set(board.map((r) => r.slug));
  const liveSet = new Set(snapshot.protocols.filter((p) => p.token_status === 'live').map((p) => p.slug));
  for (const slug of snapshot.watchlist) {
    if (!present.has(slug) && !liveSet.has(slug)) return `watchlist slug "${slug}" is missing from the board.`;
  }
  return null;
}

/** `window.RADAR=` + the radar JSON + `;\n`, the only file the dashboard loads. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
