export type Direction = "long" | "short";
export type SignalStatus = "ACTIVE" | "EXECUTED" | "REJECTED" | "CLOSED" | "EXPIRED";
export type SignalType = "LISTING" | "MEME" | "SMART_MONEY" | "ONCHAIN" | "TECHNICAL" | "SOCIAL" | "RESEARCH";
export type Chain = "ethereum" | "bsc" | "solana" | "base" | "arbitrum" | "polygon" | "avalanche" | "unknown";
export type ExchangeId = "binance" | "mexc" | "bybit" | "bitget" | "okx" | "kucoin" | "gate";

export interface TradeSignal {
  type: SignalType;
  symbol: string;
  chain: Chain;
  direction: Direction;
  confidence: number; // 0-100
  score: number; // composite score 0-100

  price?: number;
  entryLow?: number;
  entryHigh?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  stopLoss?: number;
  tp1Pct?: string;
  tp2Pct?: string;
  tp3Pct?: string;
  slPct?: string;

  leverage: number;
  positionSize?: number;
  exchange?: ExchangeId;

  catalyst: string;
  thesis?: string;
  sources: SignalType[];
  agentScores: Record<string, number>;
  rawData?: Record<string, any>;

  // Meme-specific
  deployerRisk?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  lpLocked?: boolean;
  lpBurned?: boolean;
  sniperCount?: number;

  // Smart money specific
  smartWalletsBuying?: number;
  smartWalletConfidence?: number;

  // On-chain specific
  bridgeFlowUsd?: number;
  exchangeNetflow?: number;
  accumulationScore?: number;

  // Social specific
  sentimentScore?: number;
  kolMentions?: number;
  narrativeMatch?: string;

  // Research specific
  researchConviction?: number;
  redFlags?: string[];
}

export interface AgentResult<T = any> {
  agent: string;
  signals: T[];
  metrics: {
    candidatesAnalyzed: number;
    signalsGenerated: number;
    durationMs: number;
  };
}

export interface PositionState {
  id: string;
  signalId?: string;
  symbol: string;
  exchange: ExchangeId;
  direction: Direction;
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
  stopLoss: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  openedAt: Date;
  status: "OPEN" | "CLOSED" | "STOPPED_OUT" | "LIQUIDATED";
}

export interface PortfolioState {
  totalValue: number;
  availableCapital: number;
  allocatedCapital: number;
  totalPnl: number;
  totalPnlPct: number;
  positions: PositionState[];
  dailyPnl: number;
  dailyDrawdown: number;
  maxDrawdown: number;
  heat: number; // 0-1, percentage of capital deployed
}
