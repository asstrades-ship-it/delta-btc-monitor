// Background signal engine: signal/indicator functions copied from uploaded index.html.
// BTCUSD 5m only; verified Delta candles only; no simulated/Binance trading alerts.
'use strict';
const fs = require('node:fs');
const SYMBOLS = ['BTCUSD'];
const TF_CONFIG = {'5m':{ms:300000},'15m':{ms:900000},'1h':{ms:3600000},'4h':{ms:14400000}};
const state = {candlesByKey:{},deltaCandleKeys:{},lastEvaluatedCandle:{},alertBaselineReady:{},lastSignalState:{},entryExitAlertsOn:true,volThreshold:1.0,alertsPaused:false};
const alerts=[];
function triggerAlert(msg,type='info'){alerts.push({msg,type});}
function formatPrice(val,sym){if(!Number.isFinite(val))return '—';return val.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function ensureSeries(sym,tf){return state.candlesByKey[getSeriesKey(sym,tf)] || [];}
  function getSeriesKey(sym, tf) {
    return `${sym}__${tf}`;
  }

  function aggregateCandles(candles, targetMs) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const buckets = new Map();
    for (const c of candles) {
      const bucketStart = Math.floor(c.t / targetMs) * targetMs;
      let b = buckets.get(bucketStart);
      if (!b) {
        b = { t: bucketStart, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
        buckets.set(bucketStart, b);
      } else {
        b.h = Math.max(b.h, c.h);
        b.l = Math.min(b.l, c.l);
        b.c = c.c;
        b.v += c.v || 0;
      }
    }
    return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  }

  function calcATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length <= period) return 0;
    let atr = 0;
    for (let i = 1; i <= period; i++) {
      const c = candles[i], prevC = candles[i - 1].c;
      atr += Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
    }
    atr /= period;
    // Wilder's smoothing, the standard ATR calculation.
    for (let i = period + 1; i < candles.length; i++) {
      const c = candles[i], prevC = candles[i - 1].c;
      const tr = Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
      atr = ((atr * (period - 1)) + tr) / period;
    }
    return Number.isFinite(atr) ? atr : 0;
  }

  function getAnchorATRs(sym, activeTf, activeCandles) {
    let atr1h = 0;
    let atr4h = 0;

    if (activeTf === '1h') atr1h = calcATR(activeCandles, 14);
    if (activeTf === '4h') atr4h = calcATR(activeCandles, 14);

    const h1Series = state.deltaCandleKeys[getSeriesKey(sym, '1h')] === true ? ensureSeries(sym, '1h') : [];
    const h4Series = state.deltaCandleKeys[getSeriesKey(sym, '4h')] === true ? ensureSeries(sym, '4h') : [];

    if (!atr1h) {
      const cfg = TF_CONFIG[activeTf] || TF_CONFIG['5m'];
      if (cfg.ms < TF_CONFIG['1h'].ms && activeCandles.length >= 28) {
        const agg1h = aggregateCandles(activeCandles, TF_CONFIG['1h'].ms);
        atr1h = agg1h.length >= 6 ? calcATR(agg1h, Math.min(14, agg1h.length - 1)) : (h1Series.length ? calcATR(h1Series, 14) : 0);
      } else {
        atr1h = h1Series.length ? calcATR(h1Series, 14) : 0;
      }
    }

    if (!atr4h) {
      const cfg = TF_CONFIG[activeTf] || TF_CONFIG['5m'];
      if (cfg.ms < TF_CONFIG['4h'].ms && activeCandles.length >= 56) {
        const agg4h = aggregateCandles(activeCandles, TF_CONFIG['4h'].ms);
        atr4h = agg4h.length >= 6 ? calcATR(agg4h, Math.min(14, agg4h.length - 1)) : (h4Series.length ? calcATR(h4Series, 14) : 0);
      } else {
        atr4h = h4Series.length ? calcATR(h4Series, 14) : 0;
      }
    }

    return {
      tfAtr: calcATR(activeCandles, 14),
      atr1h,
      atr4h
    };
  }

  function calcWMA(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const denom = (period * (period + 1)) / 2;
    for (let i = period - 1; i < values.length; i++) {
      let weightedSum = 0;
      for (let k = 0; k < period; k++) {
        weightedSum += values[i - k] * (period - k);
      }
      out[i] = weightedSum / denom;
    }
    return out;
  }

  function calcEMA(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const mult = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    let ema = sum / period;
    out[period - 1] = ema;
    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * mult + ema;
      out[i] = ema;
    }
    return out;
  }

  function calcVWAP(candles) {
    const out = new Array(candles.length).fill(null);
    let cumPV = 0;
    let cumV = 0;
    let currentDay = null;

    for (let i = 0; i < candles.length; i++) {
      const d = new Date(candles[i].t);
      const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (dayKey !== currentDay) {
        currentDay = dayKey;
        cumPV = 0;
        cumV = 0;
      }
      const typical = (candles[i].h + candles[i].l + candles[i].c) / 3;
      const vol = Math.max(0, candles[i].v || 0);
      cumPV += typical * vol;
      cumV += vol;
      out[i] = cumV > 0 ? cumPV / cumV : typical;
    }
    return out;
  }

  function calcRSI(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const change = values[i] - values[i - 1];
      if (change > 0) gain += change; else loss -= change;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    const value = () => avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - (100 / (1 + avgGain / avgLoss));
    out[period] = value();
    for (let i = period + 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
      out[i] = value();
    }
    return out;
  }

  function calcADX(candles, period = 14) {
    const n = candles.length;
    const adx = new Array(n).fill(null);
    const plusDI = new Array(n).fill(null);
    const minusDI = new Array(n).fill(null);
    if (n <= period * 2) return { adx, plusDI, minusDI };
    const tr = new Array(n).fill(0), plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = candles[i].h - candles[i - 1].h;
      const down = candles[i - 1].l - candles[i].l;
      tr[i] = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
      plusDM[i] = up > down && up > 0 ? up : 0;
      minusDM[i] = down > up && down > 0 ? down : 0;
    }
    let trSum = 0, plusSum = 0, minusSum = 0;
    for (let i = 1; i <= period; i++) { trSum += tr[i]; plusSum += plusDM[i]; minusSum += minusDM[i]; }
    const dx = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      if (i > period) {
        trSum = trSum - trSum / period + tr[i];
        plusSum = plusSum - plusSum / period + plusDM[i];
        minusSum = minusSum - minusSum / period + minusDM[i];
      }
      const p = trSum > 0 ? 100 * plusSum / trSum : 0;
      const m = trSum > 0 ? 100 * minusSum / trSum : 0;
      plusDI[i] = p; minusDI[i] = m;
      dx[i] = (p + m) > 0 ? 100 * Math.abs(p - m) / (p + m) : 0;
    }
    const firstAdxIndex = period * 2 - 1;
    let dxSum = 0;
    for (let i = period; i <= firstAdxIndex; i++) dxSum += dx[i] || 0;
    adx[firstAdxIndex] = dxSum / period;
    for (let i = firstAdxIndex + 1; i < n; i++) adx[i] = ((adx[i - 1] * (period - 1)) + (dx[i] || 0)) / period;
    return { adx, plusDI, minusDI };
  }

  function computeIndicators(candles) {
    const closes = candles.map(c => c.c);
    const dmi = calcADX(candles, 14);
    return {
      wma12:  calcWMA(closes, 12),
      wma144: calcWMA(closes, 144),
      ema20:  calcEMA(closes, 20),
      ema50:  calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
      vwap:   calcVWAP(candles),
      rsi14:  calcRSI(closes, 14),
      adx14:  dmi.adx,
      plusDI14: dmi.plusDI,
      minusDI14: dmi.minusDI
    };
  }

  function getClosed15mTrend(sym) {
    const key = getSeriesKey(sym, '15m');
    const candles = ensureSeries(sym, '15m');
    if (state.deltaCandleKeys[key] !== true || candles.length < 55) return { direction: 'UNAVAILABLE', label: '15m data unavailable' };
    const tfMs = TF_CONFIG['15m'].ms;
    let i = candles.length - 1;
    while (i >= 0 && candles[i].t + tfMs > Date.now()) i--;
    if (i < 50) return { direction: 'UNAVAILABLE', label: 'Waiting for closed 15m candle' };
    const closed = candles.slice(0, i + 1);
    const mtf = computeIndicators(closed);
    const price = closed[i].c, e20 = mtf.ema20[i], e50 = mtf.ema50[i];
    if (![e20, e50].every(Number.isFinite)) return { direction: 'UNAVAILABLE', label: '15m EMA warming up' };
    if (price > e20 && e20 > e50) return { direction: 'BULLISH', label: 'Bullish · 15m 20 EMA > 50 EMA', price, e20, e50 };
    if (price < e20 && e20 < e50) return { direction: 'BEARISH', label: 'Bearish · 15m 20 EMA < 50 EMA', price, e20, e50 };
    return { direction: 'NEUTRAL', label: 'Neutral · 15m EMAs mixed', price, e20, e50 };
  }

  function calc1hORB(sym, activeTf, activeCandles) {
    const h1Key = getSeriesKey(sym, '1h');
    const hourlyIsVerified = activeTf === '1h' ? state.deltaCandleKeys[getSeriesKey(sym, activeTf)] === true : state.deltaCandleKeys[h1Key] === true;
    if (!hourlyIsVerified) return null;
    const source = activeTf === '1h' ? activeCandles : ensureSeries(sym, '1h');
    if (!Array.isArray(source) || source.length === 0) return null;

    const latest = source[source.length - 1];
    const d = new Date(latest.t);
    const dayStartUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);

    // The opening range is valid only after the first UTC hourly candle has closed.
    const orbBar = source.find(c => c.t >= dayStartUtc && c.t < dayStartUtc + 3600 * 1000 && c.t + 3600 * 1000 <= Date.now());
    if (!orbBar) return null;

    let high = Number(orbBar.h);
    let low = Number(orbBar.l);

    if (Array.isArray(activeCandles) && activeCandles.length > 0 && Number.isFinite(orbBar.t)) {
      const winStart = orbBar.t;
      const winEnd = winStart + 3600 * 1000;
      const subBars = activeCandles.filter(c => c.t >= winStart && c.t < winEnd);
      for (const sb of subBars) {
        if (Number.isFinite(sb.h) && sb.h > high) high = sb.h;
        if (Number.isFinite(sb.l) && sb.l < low) low = sb.l;
      }
    }

    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    if (high <= low) {
      const pad = Math.max(high * 0.001, 1e-6);
      high += pad;
      low -= pad;
    }

    const mid = (high + low) / 2;
    const width = high - low;
    return { high, mid, low, width, startTime: orbBar.t };
  }

  function evaluateCrossoversAndSignals(sym, tf, candles, ind, atrInfo, orb) {
    const key = getSeriesKey(sym, tf);
    // Never generate trading alerts from seed data, Binance fallback, or a spot price
    // grafted onto another venue's candles. Delta candles are required.
    if (!state.deltaCandleKeys[key] || !Array.isArray(candles) || candles.length < 3) return;
    const tfMs = (TF_CONFIG[tf] || TF_CONFIG['5m']).ms;
    const now = Date.now();
    let i = candles.length - 1;
    while (i >= 0 && candles[i].t + tfMs > now) i--;
    if (i < 2) return;
    const candleTime = candles[i].t;
    const evalKey = `${sym}_${tf}`;
    if (state.lastEvaluatedCandle[evalKey] === candleTime) return;
    state.lastEvaluatedCandle[evalKey] = candleTime;

    const prev = candles[i - 1].c;
    const curr = candles[i].c;
    const checks = [
      { key: 'wma12', label: '12 WMA', val: ind.wma12[i], prevVal: ind.wma12[i - 1] },
      { key: 'wma144', label: '144 WMA', val: ind.wma144[i], prevVal: ind.wma144[i - 1] },
      { key: 'ema20', label: '20 EMA', val: ind.ema20[i], prevVal: ind.ema20[i - 1] },
      { key: 'ema50', label: '50 EMA', val: ind.ema50[i], prevVal: ind.ema50[i - 1] },
      { key: 'ema200', label: '200 EMA', val: ind.ema200[i], prevVal: ind.ema200[i - 1] },
      { key: 'vwap', label: 'VWAP', val: ind.vwap[i], prevVal: ind.vwap[i - 1] }
    ];
    if (orb) checks.push(
      { key: 'orbH', label: '1h ORB High', val: orb.high, prevVal: orb.high },
      { key: 'orbM', label: '1h ORB Mid', val: orb.mid, prevVal: orb.mid },
      { key: 'orbL', label: '1h ORB Low', val: orb.low, prevVal: orb.low }
    );

    // First closed candle after connecting establishes a baseline; it must not
    // create a historical alert just because the app was opened mid-trend.
    const isBaseline = !state.alertBaselineReady?.[evalKey];
    state.alertBaselineReady = state.alertBaselineReady || {};
    for (const c of checks) {
      if (!Number.isFinite(c.val)) continue;
      const crossedUp = Number.isFinite(c.prevVal) && candles[i - 1].c <= c.prevVal && curr > c.val;
      const crossedDown = Number.isFinite(c.prevVal) && candles[i - 1].c >= c.prevVal && curr < c.val;
      if (!isBaseline && (crossedUp || crossedDown)) {
        const side = crossedUp ? 'ABOVE' : 'BELOW';
        triggerAlert(`${sym} (${tf}) candle closed ${side} ${c.label} @ ${formatPrice(curr, sym)}`, crossedUp ? 'bull' : 'bear');
      }
    }
    state.alertBaselineReady[evalKey] = true;

    if (!state.entryExitAlertsOn) return;
    const e20 = ind.ema20[i], e50 = ind.ema50[i], e200 = ind.ema200[i], vw = ind.vwap[i];
    const rsi = ind.rsi14[i], adx = ind.adx14[i];
    if (![e20, e50, vw].every(Number.isFinite)) return;
    const recentVols = candles.slice(Math.max(0, i - 20), i).map(x => x.v || 0);
    const avgVol = recentVols.length ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0;
    const volRatio = avgVol > 0 ? (candles[i].v || 0) / avgVol : 0;
    const atr = atrInfo.tfAtr || atrInfo.atr1h || Math.abs(curr - e50);
    const mtfTrend = getClosed15mTrend(sym);
    const bullTrend = curr > e20 && e20 > e50 && (!Number.isFinite(e200) || e50 >= e200) && curr > vw;
    const bearTrend = curr < e20 && e20 < e50 && (!Number.isFinite(e200) || e50 <= e200) && curr < vw;
    const trendStrengthOk = Number.isFinite(adx) && adx >= 20;
    const longFilters = Number.isFinite(rsi) && rsi > 50 && trendStrengthOk && mtfTrend.direction === 'BULLISH';
    const shortFilters = Number.isFinite(rsi) && rsi < 50 && trendStrengthOk && mtfTrend.direction === 'BEARISH';
    let sigType = 'NONE';
    if (bullTrend && longFilters && volRatio >= state.volThreshold && candles[i].c >= candles[i].o) sigType = 'LONG_ENTRY';
    else if (bearTrend && shortFilters && volRatio >= state.volThreshold && candles[i].c < candles[i].o) sigType = 'SHORT_ENTRY';
    else if (prev >= ind.ema20[i - 1] && curr < e20 && curr < vw) sigType = 'LONG_EXIT';
    else if (prev <= ind.ema20[i - 1] && curr > e20 && curr > vw) sigType = 'SHORT_EXIT';

    const sigKey = `${sym}_${tf}_signal`;
    const lastSig = state.lastSignalState[sigKey] || 'NONE';
    if (!isBaseline && sigType !== 'NONE' && sigType !== lastSig) {
      if (sigType === 'LONG_ENTRY') {
        triggerAlert(`LONG ENTRY ${sym} (${tf}) @ ${formatPrice(curr, sym)} | RSI ${rsi.toFixed(1)} | ADX ${adx.toFixed(1)} | 15m BULL | SL ${formatPrice(curr - atr * 1.5, sym)} | TP1 ${formatPrice(curr + atr * 1.5, sym)} | TP2 ${formatPrice(curr + atr * 3, sym)} | Vol ${volRatio.toFixed(2)}x`, 'bull');
      } else if (sigType === 'SHORT_ENTRY') {
        triggerAlert(`SHORT ENTRY ${sym} (${tf}) @ ${formatPrice(curr, sym)} | RSI ${rsi.toFixed(1)} | ADX ${adx.toFixed(1)} | 15m BEAR | SL ${formatPrice(curr + atr * 1.5, sym)} | TP1 ${formatPrice(curr - atr * 1.5, sym)} | TP2 ${formatPrice(curr - atr * 3, sym)} | Vol ${volRatio.toFixed(2)}x`, 'bear');
      } else if (sigType === 'LONG_EXIT') {
        triggerAlert(`EXIT LONG ${sym} (${tf}) @ ${formatPrice(curr, sym)} — candle closed below 20 EMA & VWAP`, 'bear');
      } else if (sigType === 'SHORT_EXIT') {
        triggerAlert(`EXIT SHORT ${sym} (${tf}) @ ${formatPrice(curr, sym)} — candle closed above 20 EMA & VWAP`, 'bull');
      }
    }
    state.lastSignalState[sigKey] = sigType;
  }

async function getDeltaCandles(sym,tf){
 const seconds={'5m':300,'15m':900,'1h':3600,'4h':14400}[tf];
 const end=Math.floor(Date.now()/1000),start=end-seconds*245;
 const hosts=['https://api.india.delta.exchange','https://api.delta.exchange'];
 for(const host of hosts){
  try{
   const u=new URL('/v2/history/candles',host);
   u.searchParams.set('symbol',sym);u.searchParams.set('resolution',tf);
   u.searchParams.set('start',String(start));u.searchParams.set('end',String(end));
   const r=await fetch(u,{signal:AbortSignal.timeout(12000)});
   if(!r.ok)continue;
   const payload=await r.json();
   const rows=Array.isArray(payload)?payload:payload?.result;
   if(!Array.isArray(rows))continue;
   const parsed=rows.map(r=>{
    const rawT=Number(r.time??r.t??0);
    return {t:rawT>1e12?rawT:rawT*1000,o:Number(r.open??r.o),h:Number(r.high??r.h),l:Number(r.low??r.l),c:Number(r.close??r.c),v:Number(r.volume??r.v??0)};
   }).filter(c=>Number.isFinite(c.t)&&c.t>0&&[c.o,c.h,c.l,c.c,c.v].every(Number.isFinite)&&c.o>0&&c.h>0&&c.l>0&&c.c>0&&c.v>=0&&c.h>=Math.max(c.o,c.c,c.l)&&c.l<=Math.min(c.o,c.c,c.h));
   parsed.sort((a,b)=>a.t-b.t);
   const unique=parsed.filter((c,i)=>i===0||c.t!==parsed[i-1].t);
   if(unique.length>=200)return unique;
  }catch(e){console.error(host,tf,e.message);}
 }
 throw new Error('Verified Delta '+sym+' '+tf+' candles unavailable');
}
async function sendTelegram(msg){
 const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
 if(!token||!chat)throw new Error('Missing Telegram GitHub secrets');
 const r=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chat,text:'📊 Delta Exchange alert\n'+msg})
 });
 const j=await r.json();if(!r.ok||!j.ok)throw new Error('Telegram send failed: '+(j.description||r.status));
}
async function main(){
 const path='btc-monitor-state.json';
 let saved={};try{saved=JSON.parse(fs.readFileSync(path,'utf8'));}catch{}
 const sym='BTCUSD',tf='5m';
 for(const interval of ['5m','15m','1h','4h']){
  const key=getSeriesKey(sym,interval);
  state.candlesByKey[key]=await getDeltaCandles(sym,interval);
  state.deltaCandleKeys[key]=true;
 }
 const key=getSeriesKey(sym,tf),candles=ensureSeries(sym,tf);
 const closed=candles.filter(c=>c.t+TF_CONFIG[tf].ms<=Date.now());
 if(closed.length<200)throw new Error('Not enough completed Delta candles');
 const last=closed.at(-1).t;
 // Fresh installations establish a baseline without sending old signals.
 if(!saved.initialized){
  saved={initialized:true,lastCandle:last,lastSignal:'NONE'};
  fs.writeFileSync(path,JSON.stringify(saved,null,2)+'\n');
  console.log('Baseline initialized; no historical alerts sent');return;
 }
 if(last<=saved.lastCandle){console.log('No new completed candle');return;}
 // Do not emit stale signals after a missed schedule / outage.
 if(Date.now()-(last+TF_CONFIG[tf].ms)>12*60*1000){
  saved.lastCandle=last;fs.writeFileSync(path,JSON.stringify(saved,null,2)+'\n');
  console.log('Stale candle skipped');return;
 }
 const evalKey=sym+'_'+tf;
 state.alertBaselineReady[evalKey]=true;
 state.lastSignalState[evalKey+'_signal']=saved.lastSignal||'NONE';
 const ind=computeIndicators(candles),atrInfo=getAnchorATRs(sym,tf,candles),orb=calc1hORB(sym,tf,candles);
 evaluateCrossoversAndSignals(sym,tf,candles,ind,atrInfo,orb);
 for(const alert of alerts)await sendTelegram(alert.msg);
 saved.lastCandle=last;
 saved.lastSignal=state.lastSignalState[evalKey+'_signal']||'NONE';
 fs.writeFileSync(path,JSON.stringify(saved,null,2)+'\n');
 console.log('Completed candle',new Date(last).toISOString(),'alerts',alerts.length);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
