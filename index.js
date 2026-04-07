const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');

// ── All VIPBox sports categories ──────────────────────────────────────────────
const CATEGORIES = [
    { id: 'mma',        name: 'MMA / UFC',    path: '/ufc-live' },
    { id: 'wwe',        name: 'WWE',          path: '/wwe-live' },
    { id: 'boxing',     name: 'Boxing',       path: '/boxing-live' },
    { id: 'football',   name: 'Football',     path: '/football-live' },
    { id: 'nfl',        name: 'NFL',          path: '/nfl-live' },
    { id: 'basketball', name: 'Basketball',   path: '/basketball-live' },
    { id: 'hockey',     name: 'Hockey',       path: '/hockey-live' },
    { id: 'tennis',     name: 'Tennis',       path: '/tennis-live' },
    { id: 'golf',       name: 'Golf',         path: '/golf-live' },
    { id: 'rugby',      name: 'Rugby',        path: '/rugby-live' },
    { id: 'formula1',   name: 'Formula 1',    path: '/formula-1-live' },
    { id: 'motogp',     name: 'MotoGP',       path: '/motogp-live' },
    { id: 'nascar',     name: 'NASCAR',       path: '/nascar-live' },
    { id: 'motorsports',name: 'Motorsports',  path: '/motorsports-live' },
    { id: 'ncaaf',      name: 'NCAAF',        path: '/ncaaf-live' },
    { id: 'afl',        name: 'AFL',          path: '/afl-live' },
    { id: 'darts',      name: 'Darts',        path: '/darts-live' },
    { id: 'snooker',    name: 'Snooker',      path: '/snooker-live' },
    { id: 'fighting',   name: 'Fighting',     path: '/fighting-live' },
    { id: 'others',     name: 'Others',       path: '/others-live' },
];

const BASE_URL = 'https://www.vipbox.lc';

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

// ── Scrape events from a category page ───────────────────────────────────────
async function scrapeEvents(categoryPath) {
    const cacheKey = `events:${categoryPath}`;
    const cached = fromCache(cacheKey);
    if (cached) return cached;

    const html = await fetchHtml(BASE_URL + categoryPath);
    const $ = cheerio.load(html);
    const events = [];

    // VIPBox lists events as links matching /sport/event-name-streams
    $('a[href*="-streams"]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const title = $(el).text().trim();
        // Only internal event links
        if (!href.startsWith('http') && href.includes('/') && title.length > 2) {
            const fullUrl = BASE_URL + href;
            const id = href.replace(/\//g, ':').replace(/^:/, '');
            if (!events.find(e => e.id === id)) {
                events.push({ id, title, url: fullUrl });
            }
        }
    });

    toCache(cacheKey, events);
    return events;
}

// ── Scrape stream links from an event page ────────────────────────────────────
async function scrapeStreams(eventUrl) {
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey);
    if (cached) return cached;

    const html = await fetchHtml(eventUrl);
    const $ = cheerio.load(html);
    const streams = [];

    // Method 1: m3u8 URLs in scripts
    $('script').each((_, el) => {
        const src = $(el).html() || '';
        const matches = [...src.matchAll(/https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?/gi)];
        matches.forEach(m => {
            if (!streams.find(s => s.url === m[0])) {
                streams.push({ url: m[0], name: `VIPBox HLS ${getQuality(m[0])}` });
            }
        });
    });

    // Method 2: iframe embeds — follow them to find m3u8
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

// ── Build the addon ───────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.vipbox.allsports',
    version: '2.0.0',
    name: 'VIPBox All Sports',
    description: 'Live sports streams from VIPBox — all categories',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: ['vipbox'],
    catalogs: CATEGORIES.map(cat => ({
        type: 'series',
        id: `vipbox_${cat.id}`,
        name: cat.name
    }))
});

// ── Catalog handler — list events for a sport ─────────────────────────────────
builder.defineCatalogHandler(async (args) => {
    const cat = CATEGORIES.find(c => `vipbox_${c.id}` === args.id);
    if (!cat) return { metas: [] };

    if (args.extra && args.extra.search) return { metas: [] };

    try {
        const events = await scrapeEvents(cat.path);
        const metas = events.map(ev => ({
            id: `vipbox:${ev.id}`,
            type: 'series',
            name: ev.title,
            poster: `https://www.vipbox.lc/img/vipbox.svg`,
            description: `Live stream: ${ev.title}`
        }));
        return { metas };
    } catch (e) {
        console.error(`Catalog error for ${cat.id}:`, e.message);
        return { metas: [] };
    }
});

// ── Meta handler — single event detail ───────────────────────────────────────
builder.defineMetaHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { meta: null };

    // Reconstruct URL from id: vipbox:wwe:wwe-nxt-streams → /wwe/wwe-nxt-streams
    const path = args.id.replace('vipbox:', '').replace(/:/g, '/');
    const name = path.split('/').pop().replace(/-streams$/, '').replace(/-/g, ' ');

    return {
        meta: {
            id: args.id,
            type: 'series',
            name: name.replace(/\b\w/g, c => c.toUpperCase()),
            poster: 'https://www.vipbox.lc/img/vipbox.svg',
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

// ── Stream handler — get actual m3u8 links ────────────────────────────────────
builder.defineStreamHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { streams: [] };

    // Strip the :1:1 episode suffix if present
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

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`VIPBox All Sports addon running on port ${PORT}`);
