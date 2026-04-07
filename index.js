#!/usr/bin/env node
'use strict';
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const axios = require('axios');

const SITES = [
  'https://vipbox.lc', 'https://viprow.me', 'https://buffstreams.app',
  'https://crackstreams.dev', 'https://sportsurge.net', 'https://720pstream.me'
];

const CACHE = new Map();

async function findEvent(query) {
  const events = [];
  for (const site of SITES) {
    try {
      const { data } = await axios.get(site, { timeout: 10000 });
      const $ = cheerio.load(data);
      
      $('a[href*="event"],a[href*="watch"],a[href*="stream"],a[href*="/match"],.live-link').each((i, el) => {
        const txt = $(el).text().toLowerCase();
        const href = $(el).attr('href');
        if ((txt.includes(query) || query.includes(txt)) && href) {
          events.push(site.replace(/\/$/, '') + (href.startsWith('/') ? '' : '/') + href);
        }
      });
    } catch(e) {
      console.log(`Site failed: ${site}`);
    }
  }
  return [...new Set(events)].slice(0, 3);
}

async function captureNetworkRequests(eventUrl) {
  const m3u8s = [];
  try {
    const { data } = await axios.get(eventUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    
    const $ = cheerio.load(data);

    // Extract from JavaScript (Network Tab simulation)
    $('script').each((_, s) => {
      const js = $(s).html?.() || '';
      const patterns = [
        /["']([^"']+\.m3u8[^"']*(?:token|key|auth|pass)[^"']*?)["']/gi,
        /hls["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/gi,
        /playlist["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/gi,
        /src["']\s*:\s*["']([^"']+\.m3u8[^"']*)/gi,
        /fetch\s*\(["']([^"']+\.m3u8)/gi
      ];
      
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(js)) !== null) {
          const url = match[1];
          if (url.includes('.m3u8')) {
            const fullUrl = url.startsWith('http') ? url : new URL(url, eventUrl).href;
            m3u8s.push(fullUrl);
          }
        }
      });
    });

    // API endpoints
    const base = new URL(eventUrl).origin;
    ['/hls/master.m3u8','/playlist.m3u8','/live.m3u8','/streams.m3u8'].forEach(p => {
      m3u8s.push(`${base}${p}`);
    });

  } catch(e) {
    console.log(`Network capture failed: ${eventUrl}`);
  }
  
  return [...new Set(m3u8s)].slice(0, 4);
}

async function validateM3U8(url) {
  try {
    const { data, status } = await axios.get(url, { 
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (status === 200 && data.includes('#EXTM3U') && data.includes('#EXT-X-STREAM-INF')) {
      const titleMatch = data.match(/TITLE="([^"]+)"/) || 
                        data.match(/#EXTINF:[^,]+,/i);
      const title = titleMatch ? titleMatch[1] || titleMatch[0].split(',')[1] || '🔴 LIVE PPV' : '🔴 LIVE Stream';
      
      return {
        url,
        title,
        tokenized: url.includes('token=') || url.includes('key=') || url.includes('auth=') || url.includes('pass=')
      };
    }
  } catch(e) {}
  return null;
}

const builder = new addonBuilder({
  id: 'com.network.tab.hunter',
  version: '4.1.0',
  name: '🕵️ Network Tab Hunter',
  description: 'VIPBOX DevTools → Tokenized M3U8 Streams',
  resources: ['stream'],
  types: ['movie', 'series', 'tvchannel']
});

builder.defineStreamHandler(async (args) => {
  const query = args.manifest?.id?.split(':').pop()?.toLowerCase() || '';
  if (!query || query.length < 3) return { streams: [] };
  
  const cacheKey = `streams:${query}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 300000) return cached;
  
  console.log(`🔍 Network hunting: ${query}`);
  
  const events = await findEvent(query);
  const allM3u8 = [];
  
  for (const event of events) {
    console.log(`📡 Capturing: ${event}`);
    const pageM3u8 = await captureNetworkRequests(event);
    allM3u8.push(...pageM3u8);
  }
  
  const streams = [];
  const tests = allM3u8.slice(0, 6).map(validateM3U8);
  const results = await Promise.all(tests);
  
  results.forEach((r, i) => {
    if (r) {
      streams.push({
        name: r.tokenized ? `🔑 ${r.title}` : `🔴 ${r.title}`,
        url: r.url,
        title: r.title,
        behaviorHints: { notWebReady: true }
      });
      console.log(`✅ Stream ${i+1}: ${r.url}`);
    }
  });
  
  const result = { streams };
  CACHE.set(cacheKey, { ...result, ts: Date.now() });
  console.log(`🎉 ${streams.length} tokenized streams for ${query}`);
  return result;
});

const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`🕵️ Network Tab Hunter → http://localhost:${port}/manifest.json`);
