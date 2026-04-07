#!/usr/bin/env node
'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const url = require('url');

const SITES = [
  'https://vipbox.lc', 'https://viprow.me', 'https://buffstreams.app',
  'https://crackstreams.dev', 'https://sportsurge.net', 'https://720pstream.me'
];

const CACHE = new Map();

function httpRequest(uri, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(uri);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Connection': 'keep-alive'
      }
    };

    const req = (parsed.protocol === 'https:' ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ status: res.statusCode, data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

async function findEvent(query) {
  const events = [];
  for (const site of SITES) {
    try {
      const { data } = await httpRequest(site);
      const $ = cheerio.load(data);
      
      $('a[href*="event"],a[href*="watch"],a[href*="stream"],a[href*="/match"],.live-link,.event-link').each((i, el) => {
        const txt = $(el).text().toLowerCase().trim();
        const href = $(el).attr('href');
        if (txt.length > 3 && (txt.includes(query) || query.includes(txt)) && href) {
          const fullUrl = href.startsWith('http') ? href : new URL(href, site).href;
          events.push(fullUrl);
        }
      });
    } catch(e) {
      console.log(`Failed site: ${site.slice(0,30)}`);
    }
  }
  return [...new Set(events)].slice(0, 3);
}

async function captureNetworkRequests(eventUrl) {
  const m3u8s = [];
  try {
    const { data } = await httpRequest(eventUrl, 15000);
    const $ = cheerio.load(data);

    $('script').each((_, s) => {
      const js = $(s).html?.() || '';
      const patterns = [
        /["']([^"']+\.m3u8[^"']*(?:token|key|auth|pass)[^"']{5,})["']/gi,
        /hls["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/gi,
        /playlist["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/gi,
        /stream["']?\s*:\s*["']([^"']+\.m3u8[^"']*)/gi
      ];
      
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(js)) !== null) {
          const u = match[1];
          if (u.includes('.m3u8')) {
            const fullUrl = u.startsWith('http') ? u : new URL(u, eventUrl).href;
            m3u8s.push(fullUrl);
          }
        }
      });
    });

    // Common HLS endpoints
    const baseUrl = new URL(eventUrl);
    ['/hls/master.m3u8', '/playlist.m3u8', '/live.m3u8', '/streams.m3u8', '/player.m3u8'].forEach(p => {
      m3u8s.push(`${baseUrl.origin}${p}`);
    });

  } catch(e) {
    console.log(`Network fail: ${eventUrl.slice(0,50)}`);
  }
  
  return [...new Set(m3u8s.filter(Boolean))].slice(0, 4);
}

async function validateM3U8(testUrl) {
  try {
    const { status, data } = await httpRequest(testUrl, 12000);
    if (status === 200 && data.includes('#EXTM3U') && (data.includes('#EXT-X-STREAM-INF') || data.includes('#EXTINF'))) {
      let title = '🔴 LIVE PPV Stream';
      const titleMatch = data.match(/(?:TITLE|TITLE=)["']?([^"',\n]+)/i) || 
                        data.match(/#EXTINF:[^,]+,/i);
      if (titleMatch) title = titleMatch[1] || titleMatch[0].split(',')[1] || title;
      
      const tokenized = testUrl.includes('token=') || testUrl.includes('key=') || testUrl.includes('auth=') || testUrl.includes('pass=');
      
      return { url: testUrl, title, tokenized };
    }
  } catch(e) {}
  return null;
}

const builder = new addonBuilder({
  id: 'com.network.hunter.v5',
  version: '5.0.0',
  name: '🕵️ Network Hunter',
  description: 'VIPBOX Network Tab → Tokenized Streams',
  resources: ['stream'],
  types: ['movie', 'series', 'tvchannel']
});

builder.defineStreamHandler(async (args) => {
  const query = args.manifest?.id?.split(':').pop()?.toLowerCase() || '';
  if (!query || query.length < 2) return { streams: [] };
  
  const cacheKey = `s:${query}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < 180000) return cached;
  
  console.log(`🔍 Hunting: ${query}`);
  
  const events = await findEvent(query);
  const allM3u8 = [];
  
  for (const event of events.slice(0, 2)) {
    console.log(`📡 ${event.slice(0,60)}`);
    const m3u8s = await captureNetworkRequests(event);
    allM3u8.push(...m3u8s);
  }
  
  const streams = [];
  for (const testUrl of [...new Set(allM3u8)].slice(0, 6)) {
    const stream = await validateM3U8(testUrl);
    if (stream) {
      streams.push({
        name: stream.tokenized ? `🔑 ${stream.title}` : `🔴 ${stream.title}`,
        url: stream.url,
        title: stream.title,
        behaviorHints: { notWebReady: true }
      });
    }
  }
  
  const result = { streams };
  CACHE.set(cacheKey, { ...result, ts: Date.now() });
  console.log(`✅ ${streams.length} streams found`);
  return result;
});

const port = process.env.PORT || 3000;
serveHTTP(builder.getInterface(), { port });
console.log(`🕵️ READY → :${port}/manifest.json`);
