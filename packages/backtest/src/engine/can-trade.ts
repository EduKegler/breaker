export interface CanTradeParams {
  barsSinceExit: number;
  cooldownBars: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  dailyPnl: number;
  maxDailyLossR: number;
  initialCapital: number;
  tradesToday: number;
  maxTradesPerDay: number;
  maxGlobalTradesDay: number;
}

export function canTrade(p: CanTradeParams): boolean {
  return (
    p.barsSinceExit >= p.cooldownBars &&
    p.consecutiveLosses < p.maxConsecutiveLosses &&
    p.dailyPnl > -(p.maxDailyLossR * p.initialCapital * 0.01) &&
    p.tradesToday < Math.min(p.maxTradesPerDay, p.maxGlobalTradesDay)
  );
}
