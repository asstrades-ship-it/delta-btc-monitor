
'use strict';

// BTC EMA 9/21 TEST
// Delta Exchange India | BTCUSD | 5m
// Closed candles only | Alerts only

const SYMBOL = 'BTCUSD';
const TIMEFRAME = '5m';
const CANDLE_SECONDS = 300;
const FAST_EMA = 9;
const SLOW_EMA = 21;

function calculateEMA(prices, period) {
  const result = new Array(prices.length).fill(null);

  if (prices.length < period) return result;

  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period)
    .reduce((sum, price) => sum + price, 0) / period;

  result[period - 1] = ema;

  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
    result[i] = ema;
  }

  return result;
}

async function fetchCandles() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - CANDLE_SECONDS * 250;

  const params = new URLSearchParams({
    symbol: SYMBOL,
    resolution: TIMEFRAME,
    start: String(start),
    end: String(now)
  });

  const url =
    'https://api.india.delta.exchange/v2/history/candles?' +
    params.toString();

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error('Delta API HTTP ' + response.status);
  }

  const payload = await response.json();

  if (payload.success === false ||
      !Array.isArray(payload.result)) {
    throw new Error('Invalid Delta API response');
  }

  const candles = payload.result.map(row => {
    const rawTime = Number(row.time);
    const time = rawTime > 1e12
      ? rawTime
      : rawTime * 1000;

    return {
      time,
      close: Number(row.close)
    };
  }).filter(c =>
    Number.isFinite(c.time) &&
    Number.isFinite(c.close) &&
    c.close > 0
  ).sort((a, b) => a.time - b.time);

  const unique = candles.filter((c, i) =>
    i === 0 || c.time !== candles[i - 1].time
  );

  const nowMs = Date.now();

  return unique.filter(c =>
    c.time + CANDLE_SECONDS * 1000 <= nowMs
  );
}

async function main() {
  console.log('BTC EMA 9/21 TEST STARTED');

  const candles = await fetchCandles();

  if (candles.length < 30) {
    throw new Error('Insufficient closed Delta candles');
  }

  const closes = candles.map(c => c.close);
  const ema9 = calculateEMA(closes, FAST_EMA);
  const ema21 = calculateEMA(closes, SLOW_EMA);

  const i = closes.length - 1;
  const p = i - 1;

  let signal = 'NO CROSSOVER';

  if (ema9[p] <= ema21[p] &&
      ema9[i] > ema21[i]) {
    signal = 'BUY';
  } else if (ema9[p] >= ema21[p] &&
             ema9[i] < ema21[i]) {
    signal = 'SELL';
  }

  console.log('Source: Delta Exchange India');
  console.log('Symbol:', SYMBOL);
  console.log('Timeframe:', TIMEFRAME);
  console.log(
    'Closed candle:',
    new Date(candles[i].time).toISOString()
  );
  console.log('Close:', closes[i]);
  console.log('EMA 9:', ema9[i].toFixed(2));
  console.log('EMA 21:', ema21[i].toFixed(2));
  console.log('Signal:', signal);

  // Test stage: log only.
  // Telegram and mobile push will be connected
  // after validating the signal engine.
}

main().catch(error => {
  console.error('EMA TEST FAILED:', error.message);
  process.exitCode = 1;
});
