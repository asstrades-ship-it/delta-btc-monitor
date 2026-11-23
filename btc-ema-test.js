
'use strict';

// Delta Exchange India BTCUSD
// EMA 9/21 crossover | 5-minute closed candles
// Telegram alerts only | No trading orders

const fs = require('node:fs');

const SYMBOL = 'BTCUSD';
const RESOLUTION = '5m';
const CANDLE_MS = 5 * 60 * 1000;
const FAST_PERIOD = 9;
const SLOW_PERIOD = 21;
const STATE_FILE = 'btc-ema-state.json';

function ema(values, period) {
  const output = Array(values.length).fill(null);

  if (values.length < period) return output;

  let average = values.slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  output[period - 1] = average;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    average =
      (values[i] - average) * multiplier + average;

    output[i] = average;
  }

  return output;
}

async function getClosedCandles() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 300 * 250;

  const params = new URLSearchParams({
    symbol: SYMBOL,
    resolution: RESOLUTION,
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
    throw new Error(`Delta API HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.success === false ||
      !Array.isArray(payload.result)) {
    throw new Error('Invalid Delta candle response');
  }

  const candles = payload.result.map(row => {
    const rawTime = Number(row.time);

    return {
      time: rawTime > 1e12
        ? rawTime
        : rawTime * 1000,
      close: Number(row.close)
    };
  }).filter(candle =>
    Number.isFinite(candle.time) &&
    Number.isFinite(candle.close) &&
    candle.close > 0
  ).sort((a, b) => a.time - b.time);

  const unique = candles.filter((candle, index) =>
    index === 0 ||
    candle.time !== candles[index - 1].time
  );

  return unique.filter(candle =>
    candle.time + CANDLE_MS <= Date.now()
  );
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  const state = JSON.parse(
    fs.readFileSync(STATE_FILE, 'utf8')
  );

  if (!Number.isFinite(state.lastCheckedCandle)) {
    throw new Error('Invalid EMA state file');
  }

  return state;
}

function saveState(candleTime) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      lastCheckedCandle: candleTime
    }, null, 2)
  );
}

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('Telegram secrets missing');
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      }),
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Telegram HTTP ${response.status}`
    );
  }

  const result = await response.json();

  if (!result.ok) {
    throw new Error('Telegram message rejected');
  }

  console.log('Telegram alert sent successfully');
}

async function main() {
  console.log('BTC EMA 9/21 MONITOR STARTED');

  const candles = await getClosedCandles();

  if (candles.length < 30) {
    throw new Error('Not enough closed candles');
  }

  const prices = candles.map(c => c.close);
  const fast = ema(prices, FAST_PERIOD);
  const slow = ema(prices, SLOW_PERIOD);

  const i = prices.length - 1;
  const previous = i - 1;
  const latest = candles[i];

  const state = readState();

  console.log('Symbol:', SYMBOL);
  console.log('Timeframe:', RESOLUTION);
  console.log(
    'Closed candle:',
    new Date(latest.time).toISOString()
  );
  console.log('Close:', latest.close);
  console.log('EMA 9:', fast[i].toFixed(2));
  console.log('EMA 21:', slow[i].toFixed(2));

  if (!state) {
    saveState(latest.time);
    console.log(
      'Baseline initialized; no historical alerts sent'
    );
    return;
  }

  if (latest.time <= state.lastCheckedCandle) {
    console.log('No new candle to check');
    return;
  }

  let lastProcessed = state.lastCheckedCandle;

  for (let j = 1; j <= i; j++) {
    const candle = candles[j];

    if (candle.time <= state.lastCheckedCandle) {
      continue;
    }

    if (fast[j - 1] === null ||
        slow[j - 1] === null) {
      continue;
    }

    let signal = null;

    if (fast[j - 1] <= slow[j - 1] &&
        fast[j] > slow[j]) {
      signal = 'BUY';
    } else if (
      fast[j - 1] >= slow[j - 1] &&
      fast[j] < slow[j]
    ) {
      signal = 'SELL';
    }

    if (signal) {
      const time = new Date(candle.time)
        .toISOString();

      const message = [
        `BTC EMA 9/21 ${signal} ALERT`,
        '',
        'Exchange: Delta Exchange India',
        `Symbol: ${SYMBOL}`,
        'Timeframe: 5 Minutes',
        `Signal: ${signal}`,
        `BTC Close: $${candle.close}`,
        `EMA 9: ${fast[j].toFixed(2)}`,
        `EMA 21: ${slow[j].toFixed(2)}`,
        `Candle Start (UTC): ${time}`,
        'Confirmed after candle close',
        '',
        'Alert only - not a trade order'
      ].join('\n');

      await sendTelegramAlert(message);
      console.log('Signal:', signal);
    } else {
      console.log(
        'NO CROSSOVER:',
        new Date(candle.time).toISOString()
      );
    }

    lastProcessed = candle.time;
    saveState(lastProcessed);
  }

  if (lastProcessed < latest.time) {
    saveState(latest.time);
  }

  console.log('EMA monitor completed');
}

main().catch(error => {
  console.error('EMA MONITOR ERROR:', error.message);
  process.exitCode = 1;
});
