import axios from "axios";
import { logger } from "../../utils/logger";
import { config } from "../../utils/config";
import { prisma } from "../../db/prisma";

export interface SocialSignal {
  platform: "twitter" | "coingecko" | "lunarcrush";
  symbol: string;
  keyword: string;
  content: string;
  authorId: string;
  authorName: string;
  authorFollowers: number;
  engagement: number;
  sentiment: number;
  isKOL: boolean;
  url: string;
  timestamp: number;
}

export interface TrendingCoin {
  symbol: string;
  name: string;
  coingeckoId: string;
  marketCapRank: number;
  score: number;
  source: "coingecko" | "twitter" | "lunarcrush";
}

const KNOWN_KOLS: Record<string, number> = {
  // Twitter user IDs of known crypto influencers (lowercase)
  "cz_binance": 1,
  "sbf_ftx": 0,
  "vitalikbuterin": 2,
  "haydenzadams": 2,
  "stani": 2,
  "cryptocobain": 2,
  "cobie": 2,
  "loomdart": 2,
  "cryptodog": 2,
  "0xfoobar": 2,
  "gammichan": 2,
  "blknoiz06": 2,
  "cryptowizardd": 1,
  "crypto_banter": 1,
  "milesdeutscher": 2,
  "rektcapital": 2,
  "pentosh1": 2,
  "hsakatrades": 1,
  "traderx0x0": 1,
  "coldbloodshill": 2,
};

const KOL_WEIGHTS: Record<number, number> = {
  0: 0,   // banned/ignore
  1: 0.5, // tier 3
  2: 1.0, // tier 2
};

export class SocialDataProvider {
  private twitterBearer: string;
  private twitterCache: Map<string, { data: SocialSignal[]; ts: number }> = new Map();
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour

  constructor() {
    this.twitterBearer = config.TWITTER_BEARER_TOKEN || "";
  }

  async fetchTrendingCoins(): Promise<TrendingCoin[]> {
    const results: TrendingCoin[] = [];

    // CoinGecko trending
    try {
      const { data } = await axios.get(
        "https://api.coingecko.com/api/v3/search/trending",
        { timeout: 10000 },
      );
      for (const coin of data?.coins || []) {
        results.push({
          symbol: coin.item?.symbol?.toUpperCase() || "",
          name: coin.item?.name || "",
          coingeckoId: coin.item?.id || "",
          marketCapRank: coin.item?.market_cap_rank || 0,
          score: coin.item?.score || 0,
          source: "coingecko",
        });
      }
    } catch (err: any) {
      logger.error(`CoinGecko trending fetch failed: ${err.message}`);
    }

    // LunarCrush trending
    try {
      const { data } = await axios.get(
        "https://lunarcrush.com/api4/public/coins/list/v2",
        { params: { sort: "galaxy_score", limit: 20 }, timeout: 10000 },
      );
      for (const coin of data?.data || []) {
        results.push({
          symbol: coin.s || "",
          name: coin.n || "",
          coingeckoId: "",
          marketCapRank: coin.cr || 0,
          score: coin.gs || 0,
          source: "lunarcrush",
        });
      }
    } catch {
      // LunarCrush requires API key — fail silently
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async searchTwitterCashtags(symbols: string[]): Promise<SocialSignal[]> {
    if (!this.twitterBearer) return [];
    if (symbols.length === 0) return [];

    const uniqueSymbols = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 10);

    // Serve from cache if fresh
    const cacheKeys = uniqueSymbols.map(s => `$${s}`);
    const now = Date.now();
    const cachedResults: SocialSignal[] = [];
    const uncached: string[] = [];

    for (const sym of uniqueSymbols) {
      const entry = this.twitterCache.get(sym);
      if (entry && now - entry.ts < this.CACHE_TTL) {
        cachedResults.push(...entry.data);
      } else {
        uncached.push(sym);
      }
    }

    if (uncached.length === 0) return cachedResults;

    // Batch query: combine up to 5 symbols per query to save API calls
    const allSignals: SocialSignal[] = [...cachedResults];

    for (let i = 0; i < uncached.length; i += 5) {
      const batch = uncached.slice(i, i + 5);
      const query = batch.map(s => `$${s}`).join(" OR ");
      const fullQuery = `(${query}) crypto -is:retweet lang:en`;

      try {
        const { data } = await axios.get(
          "https://api.twitter.com/2/tweets/search/recent",
          {
            params: {
              query: fullQuery,
              max_results: 10,
              "tweet.fields": ["public_metrics", "created_at", "author_id"].join(","),
              "user.fields": ["public_metrics", "username", "name"].join(","),
              expansions: "author_id",
            },
            headers: { Authorization: `Bearer ${this.twitterBearer}` },
            timeout: 10000,
          },
        );

        const users = (data?.includes?.users || []) as any[];
        const userMap = new Map(users.map((u: any) => [u.id, u]));

        const batchSignals: SocialSignal[] = [];

        for (const tweet of data?.data || []) {
          const user = userMap.get(tweet.author_id);
          if (!user) continue;

          const username = user.username?.toLowerCase() || "";
          const kolTier = KNOWN_KOLS[username] ?? -1;
          if (kolTier === 0) continue;

          // Find which symbol this tweet matches
          const text = (tweet.text || "").toUpperCase();
          const matchedSymbol = batch.find(s => text.includes(`$${s}`)) || batch[0];

          batchSignals.push({
            platform: "twitter",
            symbol: matchedSymbol,
            keyword: `$${matchedSymbol}`,
            content: tweet.text || "",
            authorId: tweet.author_id,
            authorName: username,
            authorFollowers: user.public_metrics?.followers_count || 0,
            engagement: (tweet.public_metrics?.like_count || 0) +
                        (tweet.public_metrics?.retweet_count || 0) +
                        (tweet.public_metrics?.reply_count || 0),
            sentiment: 0,
            isKOL: kolTier >= 0,
            url: `https://twitter.com/${username}/status/${tweet.id}`,
            timestamp: Date.parse(tweet.created_at) || Date.now(),
          });
        }

        // Cache per symbol
        for (const sym of batch) {
          const symSignals = batchSignals.filter(s => s.symbol === sym);
          this.twitterCache.set(sym, { data: symSignals, ts: now });
        }

        allSignals.push(...batchSignals);
      } catch (err: any) {
        // 402 = quota exhausted, 429 = rate limited — stop making calls
        if (err.response?.status === 402 || err.response?.status === 429) {
          logger.warn(`Twitter API quota/rate limit hit — using cache only for the next hour`);
          this.twitterCache.forEach((v) => { v.ts = now; }); // extend all caches
          break;
        }
        if (err.response?.status === 401) {
          logger.error("Twitter API unauthorized — check bearer token");
          break;
        }
      }
    }

    return allSignals;
  }

  async fetchTokenSocialStats(coingeckoId: string): Promise<any> {
    try {
      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coingeckoId}`,
        { params: { localization: false, tickers: false, community_data: true, developer_data: true }, timeout: 10000 },
      );
      return data;
    } catch {
      return null;
    }
  }
}

export const socialProvider = new SocialDataProvider();
