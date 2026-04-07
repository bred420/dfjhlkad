const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.vipbox.lc';

// All category paths to search across
const CATEGORY_PATHS = [
    '/ufc-live',
    '/wwe-live',
    '/boxing-live',
    '/football-live',
    '/nfl-live',
    '/basketball-live',
    '/hockey-live',
    '/tennis-live',
    '/golf-live',
    '/rugby-live',
    '/formula-1-live',
    '/motogp-live',
    '/nascar-live',
    '/motorsports-live',
    '/ncaaf-live',
    '/afl-live',
    '/darts-live',
    '/snooker-live',
    '/fighting-live',
    '/others-live',
];

// ── Simple in-memory cache (5 min TTL) ───────────────────────────────────────
const cache = new Map();
function fromCache(key) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < 5 * 60 * 1000) return entry.data;
    return null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchHtml(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// ── Scrape ALL events across all categories (cached) ─────────────────────────
async function getAllEvents() {
    const cacheKey = 'all_events';
    const cached = fromCache(cacheKey);
    if (cached) return cached;

    const allEvents = [];
    const seen = new Set();

    await Promise.allSettled(CATEGORY_PATHS.map(async (path) => {
        try {
            const html = await fetchHtml(BASE_URL + path);
            const $ = cheerio.load(html);

            $('a[href*="-streams"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const title = $(el).text().trim();
                if (!href.startsWith('http') && href.includes('/') && title.length > 2 && !seen.has(href)) {
                    seen.add(href);
                    // Build a clean id from the href e.g. /wwe/wwe-nxt-streams -> vipbox:wwe:wwe-nxt-streams
                    const id = 'vipbox:' + href.replace(/^\//, '').replace(/\//g, ':');
                    allEvents.push({ id, title, url: BASE_URL + href });
                }
            });
        } catch (e) {
            console.error(`Failed to scrape ${path}:`, e.message);
        }
    }));

    toCache(cacheKey, allEvents);
    return allEvents;
}

// ── Search events by query ────────────────────────────────────────────────────
async function searchEvents(query) {
    const events = await getAllEvents();
    const q = query.toLowerCase();
    return events.filter(e => e.title.toLowerCase().includes(q));
}

// ── Scrape stream links from an event page ────────────────────────────────────
async function scrapeStreams(eventUrl) {
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey);
    if (cached) return cached;

    const html = await fetchHtml(eventUrl);
    const $ = cheerio.load(html);
    const streams = [];

    // Method 1: m3u8 URLs directly in page scripts
    $('script').each((_, el) => {
        const src = $(el).html() || '';
        const matches = [...src.matchAll(/https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?/gi)];
        matches.forEach(m => {
            if (!streams.find(s => s.url === m[0])) {
                streams.push({ url: m[0], name: `VIPBox ${getQuality(m[0])}` });
            }
        });
    });

    // Method 2: Follow iframes to find embedded players
    const iframeSrcs = [];
    $('iframe').each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (src && src.startsWith('http')) iframeSrcs.push(src);
    });

    for (const src of iframeSrcs.slice(0, 3)) {
        try {
            const iframeHtml = await fetchHtml(src, 6000);
            const $i = cheerio.load(iframeHtml);
            $i('script').each((_, el) => {
                const content = $i(el).html() || '';
                const matches = [...content.matchAll(/https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?/gi)];
                matches.forEach(m => {
                    if (!streams.find(s => s.url === m[0])) {
                        streams.push({ url: m[0], name: `VIPBox Embed ${getQuality(m[0])}` });
                    }
                });
            });
        } catch (_) {}
    }

    // Method 3: video/source tags
    $('video source, source').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('.m3u8') && !streams.find(s => s.url === src)) {
            streams.push({ url: src, name: 'VIPBox Video' });
        }
    });

    const result = streams
        .filter(s => s.url && !s.url.includes('demo') && !s.url.includes('sample'))
        .slice(0, 8)
        .map(s => ({
            url: s.url,
            title: s.name,
            name: s.name,
            behaviorHints: { notWebReady: false }
        }));

    toCache(cacheKey, result);
    return result;
}

function getQuality(url) {
    if (url.includes('1080') || url.includes('fullhd')) return '1080p';
    if (url.includes('720')) return '720p';
    if (url.includes('480')) return '480p';
    return 'HLS';
}

// ── Build addon ───────────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.vipbox.allsports',
    version: '3.0.0',
    name: 'VIPBox Live Sports',
    description: 'Search live sports streams from VIPBox by event name or teams',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: ['vipbox'],
    catalogs: [
        {
            type: 'series',
            id: 'vipbox_search',
            name: 'VIPBox Live Sports',
            extra: [
                { name: 'search', isRequired: false },
            ]
        }
    ]
});

// ── Catalog: show today's events by default, or search results ────────────────
builder.defineCatalogHandler(async (args) => {
    try {
        let events;

        if (args.extra && args.extra.search) {
            // Search mode — filter by query
            events = await searchEvents(args.extra.search);
        } else {
            // Default — show everything currently listed on VIPBox
            events = await getAllEvents();
        }

        const metas = events.slice(0, 100).map(ev => ({
            id: ev.id,
            type: 'series',
            name: ev.title,
            poster: 'https://www.vipbox.lc/img/vipbox.svg',
            description: `Live on VIPBox: ${ev.title}`
        }));

        return { metas };
    } catch (e) {
        console.error('Catalog error:', e.message);
        return { metas: [] };
    }
});

// ── Meta: single event ────────────────────────────────────────────────────────
builder.defineMetaHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { meta: null };

    // Reconstruct a readable name from the id
    const parts = args.id.replace('vipbox:', '').split(':');
    const slug = parts[parts.length - 1]; // e.g. "wwe-nxt-streams"
    const name = slug
        .replace(/-streams$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    return {
        meta: {
            id: args.id,
            type: 'series',
            name,
            poster: 'https://www.vipbox.lc/img/vipbox.svg',
            description: `Watch ${name} live on VIPBox`,
            videos: [{
                id: `${args.id}:1:1`,
                title: 'Live Stream',
                season: 1,
                episode: 1,
                released: new Date().toISOString()
            }]
        }
    };
});

// ── Stream: fetch m3u8 links for the event ────────────────────────────────────
builder.defineStreamHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { streams: [] };

    // Strip :1:1 episode suffix, rebuild URL path
    const cleanId = args.id.replace(/:1:1$/, '');
    const path = cleanId.replace('vipbox:', '').replace(/:/g, '/');
    const eventUrl = `${BASE_URL}/${path}`;

    try {
        const streams = await scrapeStreams(eventUrl);
        return { streams };
    } catch (e) {
        console.error('Stream error:', e.message);
        return { streams: [] };
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`VIPBox Live Sports addon running on port ${PORT}`);
