export interface CanTradeParams {
  barsSinceExit: number;
  cooldownBars: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  dailyPnl: number;
  maxDailyLossUsd: number;
  tradesToday: number;
  maxTradesPerDay: number;
  maxGlobalTradesDay: number;
}

export function canTrade(p: CanTradeParams): boolean {
  return (
    p.barsSinceExit >= p.cooldownBars &&
    p.consecutiveLosses < p.maxConsecutiveLosses &&
    p.dailyPnl > -p.maxDailyLossUsd &&
    p.tradesToday < Math.min(p.maxTradesPerDay, p.maxGlobalTradesDay)
  );
}
