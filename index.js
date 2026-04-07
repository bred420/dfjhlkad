const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const BASE_URL = 'https://www.vipbox.lc';
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

if (!BROWSERLESS_TOKEN) {
    console.warn('WARNING: BROWSERLESS_TOKEN env var not set — stream scraping will not work!');
}

const CATEGORY_PATHS = [
    '/ufc-live', '/wwe-live', '/boxing-live', '/football-live',
    '/nfl-live', '/basketball-live', '/hockey-live', '/tennis-live',
    '/golf-live', '/rugby-live', '/formula-1-live', '/motogp-live',
    '/nascar-live', '/motorsports-live', '/ncaaf-live', '/afl-live',
    '/darts-live', '/snooker-live', '/fighting-live', '/others-live',
];

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
function fromCache(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Plain fetch for catalog pages (no JS needed) ──────────────────────────────
async function fetchHtml(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// ── Connect to Browserless remote Chrome ─────────────────────────────────────
async function getBrowser() {
    return puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}&stealth=true`,
    });
}

// ── Scrape all events across categories ──────────────────────────────────────
async function getAllEvents() {
    const cached = fromCache('all_events', 5 * 60 * 1000);
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
                    const id = 'vipbox:' + href.replace(/^\//, '').replace(/\//g, ':');
                    allEvents.push({ id, title, url: BASE_URL + href });
                }
            });
        } catch (e) {
            console.error(`Failed ${path}:`, e.message);
        }
    }));

    toCache('all_events', allEvents);
    return allEvents;
}

async function searchEvents(query) {
    const events = await getAllEvents();
    const q = query.toLowerCase();
    return events.filter(e => e.title.toLowerCase().includes(q));
}

// ── Intercept m3u8 via Browserless remote Chrome ─────────────────────────────
async function scrapeStreams(eventUrl) {
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey, 2 * 60 * 1000);
    if (cached) return cached;

    if (!BROWSERLESS_TOKEN) return { streams: [], poster: null };

    const browser = await getBrowser();
    const page = await browser.newPage();
    const capturedStreams = new Map();

    try {
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        await page.setRequestInterception(true);

        // Intercept all outgoing requests — grab any m3u8 URL with its full token
        page.on('request', req => {
            const url = req.url();
            if (url.includes('.m3u8')) {
                if (!capturedStreams.has(url)) {
                    capturedStreams.set(url, {
                        url,
                        name: `VIPBox ${getQuality(url)}`,
                        title: `VIPBox ${getQuality(url)}`,
                        behaviorHints: { notWebReady: false }
                    });
                }
            }
            // Block images/fonts/css to save bandwidth & speed things up
            if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Also catch m3u8 in response headers (handles redirects)
        page.on('response', response => {
            const url = response.url();
            const ct = response.headers()['content-type'] || '';
            if (url.includes('.m3u8') || ct.includes('mpegurl')) {
                if (!capturedStreams.has(url)) {
                    capturedStreams.set(url, {
                        url,
                        name: `VIPBox ${getQuality(url)}`,
                        title: `VIPBox ${getQuality(url)}`,
                        behaviorHints: { notWebReady: false }
                    });
                }
            }
        });

        await page.goto(eventUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for lazy players to initialise
        await new Promise(r => setTimeout(r, 5000));

        // Follow iframes
        const iframeSrcs = await page.$$eval('iframe', els =>
            els.map(el => el.src || el.getAttribute('data-src')).filter(Boolean)
        );

        for (const src of iframeSrcs.slice(0, 3)) {
            if (!src.startsWith('http')) continue;
            const iframePage = await browser.newPage();
            try {
                await iframePage.setUserAgent(
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
                );
                await iframePage.setRequestInterception(true);
                iframePage.on('request', req => {
                    const url = req.url();
                    if (url.includes('.m3u8') && !capturedStreams.has(url)) {
                        capturedStreams.set(url, {
                            url,
                            name: `VIPBox Embed ${getQuality(url)}`,
                            title: `VIPBox Embed ${getQuality(url)}`,
                            behaviorHints: { notWebReady: false }
                        });
                    }
                    if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
                iframePage.on('response', response => {
                    const url = response.url();
                    const ct = response.headers()['content-type'] || '';
                    if ((url.includes('.m3u8') || ct.includes('mpegurl')) && !capturedStreams.has(url)) {
                        capturedStreams.set(url, {
                            url,
                            name: `VIPBox Embed ${getQuality(url)}`,
                            title: `VIPBox Embed ${getQuality(url)}`,
                            behaviorHints: { notWebReady: false }
                        });
                    }
                });
                await iframePage.goto(src, { waitUntil: 'networkidle2', timeout: 20000 });
                await new Promise(r => setTimeout(r, 3000));
            } catch (e) {
                console.error('iframe error:', e.message);
            } finally {
                await iframePage.close();
            }
        }

        // Grab og:image for poster while we're here
        let poster = null;
        try {
            poster = await page.$eval(
                'meta[property="og:image"], meta[name="twitter:image"]',
                el => el.content
            );
        } catch (_) {}

        const streams = [...capturedStreams.values()]
            .filter(s => !s.url.includes('demo') && !s.url.includes('sample'))
            .slice(0, 10);

        const result = { streams, poster };
        toCache(cacheKey, result);
        return result;

    } catch (e) {
        console.error('Scrape error:', e.message);
        return { streams: [], poster: null };
    } finally {
        await page.close();
        await browser.disconnect(); // disconnect (not close) — we didn't create the browser
    }
}

function getQuality(url) {
    if (url.includes('1080') || url.includes('fullhd')) return '1080p';
    if (url.includes('720')) return '720p';
    if (url.includes('480')) return '480p';
    return 'HLS';
}

// ── Addon ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.vipbox.allsports',
    version: '5.0.0',
    name: 'VIPBox Live Sports',
    description: 'Search live sports streams from VIPBox by event name or teams',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: ['vipbox'],
    catalogs: [{
        type: 'series',
        id: 'vipbox_search',
        name: 'VIPBox Live Sports',
        extra: [{ name: 'search', isRequired: false }]
    }]
});

builder.defineCatalogHandler(async (args) => {
    try {
        const events = (args.extra && args.extra.search)
            ? await searchEvents(args.extra.search)
            : await getAllEvents();

        return {
            metas: events.slice(0, 100).map(ev => ({
                id: ev.id,
                type: 'series',
                name: ev.title,
                poster: 'https://www.vipbox.lc/img/vipbox.svg',
                description: `Live on VIPBox: ${ev.title}`
            }))
        };
    } catch (e) {
        console.error('Catalog error:', e.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { meta: null };

    const parts = args.id.replace('vipbox:', '').split(':');
    const slug = parts[parts.length - 1];
    const name = slug
        .replace(/-streams$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    const cleanId = args.id.replace(/:1:1$/, '');
    const path = cleanId.replace('vipbox:', '').replace(/:/g, '/');
    const streamCache = fromCache(`streams:${BASE_URL}/${path}`, 2 * 60 * 1000);
    const poster = streamCache?.poster || 'https://www.vipbox.lc/img/vipbox.svg';

    return {
        meta: {
            id: args.id,
            type: 'series',
            name,
            poster,
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

builder.defineStreamHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { streams: [] };

    const cleanId = args.id.replace(/:1:1$/, '');
    const path = cleanId.replace('vipbox:', '').replace(/:/g, '/');
    const eventUrl = `${BASE_URL}/${path}`;

    try {
        const { streams } = await scrapeStreams(eventUrl);
        return { streams };
    } catch (e) {
        console.error('Stream error:', e.message);
        return { streams: [] };
    }
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`VIPBox Live Sports addon running on port ${PORT}`);
