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
    const signals: SocialSignal[] = [];

    for (const symbol of symbols.slice(0, 10)) {
      try {
        const query = `$${symbol} crypto -is:retweet lang:en`;
        const { data } = await axios.get(
          "https://api.twitter.com/2/tweets/search/recent",
          {
            params: {
              query,
              max_results: 20,
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

        for (const tweet of data?.data || []) {
          const user = userMap.get(tweet.author_id);
          if (!user) continue;

          const username = user.username?.toLowerCase() || "";
          const followerCount = user.public_metrics?.followers_count || 0;
          const kolTier = KNOWN_KOLS[username] ?? -1;
          const isKOL = kolTier >= 0;

          if (kolTier === 0) continue; // skip banned accounts

          signals.push({
            platform: "twitter",
            symbol,
            keyword: `$${symbol}`,
            content: tweet.text || "",
            authorId: tweet.author_id,
            authorName: username,
            authorFollowers: followerCount,
            engagement: (tweet.public_metrics?.like_count || 0) +
                        (tweet.public_metrics?.retweet_count || 0) +
                        (tweet.public_metrics?.reply_count || 0),
            sentiment: 0, // will be calculated by LLM agent
            isKOL,
            url: `https://twitter.com/${username}/status/${tweet.id}`,
            timestamp: Date.parse(tweet.created_at) || Date.now(),
          });
        }
      } catch (err: any) {
        if (err.response?.status !== 429) {
          logger.error(`Twitter search failed for $${symbol}: ${err.message}`);
        }
      }
    }

    return signals;
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
