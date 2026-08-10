import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  DEEPSEEK_API_KEY: z.string().optional(),
  ETHERSCAN_API_KEY: z.string().optional(),
  BSCSCAN_API_KEY: z.string().optional(),
  SOLSCAN_API_KEY: z.string().optional(),
  HELIUS_RPC_URL: z.string().optional(),
  ETH_RPC_URL: z.string().optional(),
  BASE_RPC_URL: z.string().optional(),
  BSC_RPC_URL: z.string().optional(),
  ARBITRUM_RPC_URL: z.string().optional(),
  TWITTER_BEARER_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_CHAT_ID: z.string(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_SECRET: z.string().optional(),
  MEXC_API_KEY: z.string().optional(),
  MEXC_SECRET: z.string().optional(),
  BYBIT_API_KEY: z.string().optional(),
  BYBIT_SECRET: z.string().optional(),
  BITGET_API_KEY: z.string().optional(),
  BITGET_SECRET: z.string().optional(),
  MAX_POSITION_SIZE_USD: z.coerce.number().default(1000),
  MAX_PORTFOLIO_HEAT: z.coerce.number().default(0.5),
  MAX_SLIPPAGE_PCT: z.coerce.number().default(3),
  DEFAULT_LEVERAGE: z.coerce.number().default(5),
  MEME_SCOUT_INTERVAL: z.coerce.number().default(1),
  SMART_MONEY_INTERVAL: z.coerce.number().default(2),
  ONCHAIN_INTEL_INTERVAL: z.coerce.number().default(5),
  TECHNICAL_ALPHA_INTERVAL: z.coerce.number().default(5),
  SOCIAL_NARRATIVE_INTERVAL: z.coerce.number().default(10),
  MAX_DAILY_LOSS_PCT: z.coerce.number().default(10),
  MAX_DRAWDOWN_PCT: z.coerce.number().default(25),
  MIN_CONVICTION_SCORE: z.coerce.number().default(55),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Missing required environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
