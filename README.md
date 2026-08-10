# TradeSignal

Multi-agent AI crypto trading signal system.

## Agents

| Agent | Purpose |
|-------|---------|
| Meme Scout | Solana/Base pump.fun, deployer risk, LP analysis |
| Smart Money | Profitable wallet tracking, copy-trade confluence |
| On-Chain Intel | Bridge flows, exchange netflows, token unlocks |
| Technical Alpha | Multi-timeframe TA, RSI, EMA, BB, MACD, ATR, funding rates |
| Social Narrative | Twitter cashtags, KOL tracking, narrative detection |
| Research | DeepSeek LLM thesis generation + conviction scoring |
| Risk Manager | Kelly position sizing, portfolio heat, drawdown protection |
| Execution | Semi-auto with Telegram inline approve/reject buttons |

## Quick Start

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
```

## Docker

```bash
docker compose up -d
```
