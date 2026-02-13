/**
 * P0 fix: Asset metadata cache with correct decimals.
 *
 * DeDust's asset list (https://assets.dedust.io/list.json) contains
 * per-token decimals (e.g. USDT=6, TON=9). We cache this list
 * and expose helpers so quote/swap tools convert amounts correctly
 * instead of blindly using toNano/fromNano (which assume 9 decimals).
 */

import { fetchWithTimeout } from "../../../utils/fetch.js";

const ASSET_LIST_URL = "https://assets.dedust.io/list.json";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface DedustAsset {
  type: "native" | "jetton";
  address?: string;
  name: string;
  symbol: string;
  image?: string;
  decimals: number;
  sell_tax?: number;
  buy_tax?: number;
}

let cachedAssets: DedustAsset[] = [];
let cacheTimestamp = 0;

/**
 * Fetch and cache the full asset list. Returns cached version if fresh.
 * Uses stale-while-revalidate: on fetch failure, returns stale cache
 * instead of throwing (prevents blocking quote/swap on network errors).
 */
export async function getAssetList(): Promise<DedustAsset[]> {
  if (cachedAssets.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAssets;
  }

  try {
    const response = await fetchWithTimeout(ASSET_LIST_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset list: ${response.status}`);
    }

    cachedAssets = await response.json();
    cacheTimestamp = Date.now();
    return cachedAssets;
  } catch (error) {
    // Stale-while-revalidate: return old cache if available
    if (cachedAssets.length > 0) {
      console.warn("Asset list fetch failed, using stale cache:", error);
      return cachedAssets;
    }
    throw error;
  }
}

/**
 * Look up asset metadata by address (jetton master) or "ton" for native.
 */
export async function findAsset(addressOrTon: string): Promise<DedustAsset | undefined> {
  const assets = await getAssetList();

  if (addressOrTon.toLowerCase() === "ton") {
    return assets.find((a) => a.type === "native");
  }

  const normalized = addressOrTon.toLowerCase();
  return assets.find((a) => a.type === "jetton" && a.address?.toLowerCase() === normalized);
}

/**
 * Look up asset by symbol (case-insensitive, first match).
 */
export async function findAssetBySymbol(symbol: string): Promise<DedustAsset | undefined> {
  const assets = await getAssetList();
  const upper = symbol.toUpperCase();
  return assets.find((a) => a.symbol.toUpperCase() === upper);
}

/**
 * Get decimals for an asset. Falls back to 9 (TON default) if unknown.
 */
export async function getDecimals(addressOrTon: string): Promise<number> {
  const asset = await findAsset(addressOrTon);
  return asset?.decimals ?? 9;
}

/**
 * Convert a human-readable amount to on-chain units using correct decimals.
 * Uses string manipulation to avoid floating-point precision loss
 * for high-decimal tokens (e.g. 18 decimals where 10^18 > Number.MAX_SAFE_INTEGER).
 */
export function toUnits(amount: number, decimals: number): bigint {
  const str = amount.toFixed(decimals);
  const [whole, frac = ""] = str.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + padded);
}

/**
 * Convert on-chain units back to human-readable using correct decimals.
 */
export function fromUnits(units: bigint, decimals: number): number {
  const factor = 10 ** decimals;
  return Number(units) / factor;
}
