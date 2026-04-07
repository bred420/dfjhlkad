#!/usr/bin/env node
'use strict';
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const SITES = [
  'https://vipbox.lc', 'https://viprow.me', 'https://buffstreams.app',
  'https://crackstreams.dev', 'https://sportsurge.net', 'https://720pstream.me'
];

const CACHE = new Map();

async function findEvent(query) {
  const events = [];
  for (const site of SITES) {
    try {
      const res = await fetch(site);
      const $ = cheerio.load(await res.text());
      $('a[href*="event"],a[href*="watch"],a[href*="stream"],a.live-link,a[href*="/match"]').each((i, el) => {
        const txt = $(el).text().toLowerCase();
        const href = $(el).attr('href');
        if (txt.includes(query) && href) {
          events.push(site.replace(/\/$/, '') + (href.startsWith('/') ? '' : '/') + href);
        }
      });
    } catch {}
  }
  return [...new Set(events)].slice(0, 3);
}

async function captureNetworkRequests(eventUrl) {
  const m3u8s = [];
  try {
    const res = await fetch(eventUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Sec-Fetch-Site': 'same-origin'
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    // NETWORK TAB: Capture JS fetch calls + config vars
    $('script').each((_, s) => {
      const js = $(s).html?.() || '';
      const patterns = [
        /["']([^"']+\.m3u8[^"']*?token[^"']*?)["']/g,
        /["']([^"']+\.m3u8[^"']*?key[^"']*?)["']/g,
        /["']([^"']+\.m3u8[^"']*?auth[^"']*?)["']/g,
        /hls["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/g,
        /playlist["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/g,
        /fetch\s*\(\s*["']([^"']+\.m3u8)/g
      ];
      
      patterns.forEach(p => {
        let m;
        while (m = p.exec(js)) {
          const url = m[1];
          if (url.includes('.m3u8')) m3u8s.push(url.startsWith('http') ? url : new URL(url, eventUrl).href);
        }
      });
    });

    // Common API endpoints with tokens
    const base = new URL(eventUrl).origin;
    ['/hls/master.m3u8', '/playlist.m3u8', '/live.m3u8', '/streams.m3u8'].forEach(p => {
      m3u8s.push(`${base}${p}`);
    });

  } catch(e) {}
  
  return [...new Set(m3u8s)];
}

async function validateM3U8(url) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (res.status === 200) {
      const content = await res.text();
      if (content.includes('#EXTM3U') && content.includes('#EXT-X-STREAM-INF')) {
        const title = content.match(/TITLE="([^"]+)"/)?.[1] || 
                     content.match(/#EXTINF:[^,]+,/i)?.[0]?.split(',')[1] || 
                     '🔴 LIVE PPV Stream';
        return { url, title, tokenized: url.includes('token') || url.includes('key') || url.includes('auth') };
      }
    }
  } catch(e) {}
  return null;
}

const builder = new addonBuilder({
  id: 'com.network.tab.hunter',
  version: '4.0.0',
  name: '🕵️ Network Tab Hunter',
  description: 'VIPBOX Network Tab → Tokenized M3U8 Streams',
  resources: ['stream', 'meta'],
  types: ['movie', 'series', 'tvchannel']
});

builder.defineStreamHandler(async (args) => {
  const query = args.manifest?.id?.split(':').pop()?.toLowerCase() || '';
  if (!query || query.length < 3) return { streams: [] };
  
  const cacheKey = `streams:${query}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 300000) return cached;
  
  console.log(`🕵️ Hunting ${query}...`);
  
  const events = await findEvent(query);
  const allM3u8 = [];
  
  for (const event of events) {
    const pageM3u8 = await captureNetworkRequests(event);
    allM3u8.push(...pageM3u8);
  }
  
  const streams = [];
  const tests = allM3u8.slice(0, 8).map(validateM3U8);
  const results = await Promise.all(tests);
  
  results.forEach(r => {
    if (r) {
      streams.push({
        name: r.tokenized ? `🔑 ${r.title}` : `🔴 ${r.title}`,
        url: r.url,
        title: r.title,
        behaviorHints: { notWebReady: true }
      });
    }
  });
  
  const result = { streams };
  CACHE.set(cacheKey, { ...result, ts: Date.now() });
  console.log(`✅ ${streams.length} streams for ${query}`);
  return result;
});

builder.defineMetaHandler(async (args) => {
  const query = args.id.split(':').pop();
  return {
    meta: {
      id: args.id,
      type: args.type,
      name: query,
      poster: `https://via.placeholder.com/300x450/ff4444/ffffff?text=${encodeURIComponent(query)}`,
      background: `https://via.placeholder.com/1920x1080/333/fff?text=${encodeURIComponent(query)}`
    }
  };
});

const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`🕵️ Network Tab Hunter LIVE → http://localhost:${port}/manifest.json`);