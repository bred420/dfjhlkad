const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const BASE_URL = 'https://www.vipbox.lc';

const CATEGORY_PATHS = [
    '/ufc-live', '/wwe-live', '/boxing-live', '/football-live',
    '/nfl-live', '/basketball-live', '/hockey-live', '/tennis-live',
    '/golf-live', '/rugby-live', '/formula-1-live', '/motogp-live',
    '/nascar-live', '/motorsports-live', '/ncaaf-live', '/afl-live',
    '/darts-live', '/snooker-live', '/fighting-live', '/others-live',
];

// ── Cache (5 min for events, 2 min for streams since tokens expire) ───────────
const cache = new Map();
function fromCache(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Shared browser instance ───────────────────────────────────────────────────
let browserInstance = null;
async function getBrowser() {
    if (browserInstance && browserInstance.isConnected()) return browserInstance;
    browserInstance = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
        ]
    });
    return browserInstance;
}

// ── Fetch HTML with plain fetch (for catalog pages, no JS needed) ─────────────
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

// ── Scrape events list (no JS needed, cheerio is fine here) ──────────────────
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

// ── Core: use Puppeteer to intercept m3u8 network requests ───────────────────
async function scrapeStreamsWithPuppeteer(eventUrl) {
    // Streams have tokens that expire quickly — use 2 min cache
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey, 2 * 60 * 1000);
    if (cached) return cached;

    const browser = await getBrowser();
    const page = await browser.newPage();
    const capturedStreams = new Map(); // url -> stream object

    try {
        // Spoof a real browser environment
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        });

        // Block unnecessary resources to speed things up
        await page.setRequestInterception(true);
        page.on('request', req => {
            const type = req.resourceType();
            const url = req.url();

            // Capture m3u8 requests as they're made
            if (url.includes('.m3u8')) {
                const name = `VIPBox ${getQuality(url)}`;
                if (!capturedStreams.has(url)) {
                    capturedStreams.set(url, {
                        url,
                        name,
                        title: name,
                        behaviorHints: { notWebReady: false }
                    });
                }
            }

            // Block heavy resources we don't need
            if (['image', 'font', 'stylesheet'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Also intercept responses to catch m3u8 in redirects/XHR
        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';

            if (
                url.includes('.m3u8') ||
                contentType.includes('application/vnd.apple.mpegurl') ||
                contentType.includes('application/x-mpegURL')
            ) {
                const name = `VIPBox ${getQuality(url)}`;
                if (!capturedStreams.has(url)) {
                    capturedStreams.set(url, {
                        url,
                        name,
                        title: name,
                        behaviorHints: { notWebReady: false }
                    });
                }
            }
        });

        // Navigate to the event page and wait for network to settle
        await page.goto(eventUrl, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Wait a bit more for any lazy-loaded players
        await new Promise(r => setTimeout(r, 5000));

        // Also check iframes — VIPBox often embeds the player in an iframe
        const iframes = await page.$$('iframe');
        for (const iframe of iframes.slice(0, 3)) {
            try {
                const src = await iframe.evaluate(el => el.src || el.getAttribute('data-src'));
                if (src && src.startsWith('http')) {
                    const iframePage = await browser.newPage();
                    await iframePage.setUserAgent(
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
                    );
                    await iframePage.setRequestInterception(true);
                    iframePage.on('request', req => {
                        const url = req.url();
                        if (url.includes('.m3u8')) {
                            const name = `VIPBox Embed ${getQuality(url)}`;
                            if (!capturedStreams.has(url)) {
                                capturedStreams.set(url, {
                                    url, name, title: name,
                                    behaviorHints: { notWebReady: false }
                                });
                            }
                        }
                        if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
                            req.abort();
                        } else {
                            req.continue();
                        }
                    });
                    iframePage.on('response', async (response) => {
                        const url = response.url();
                        const ct = response.headers()['content-type'] || '';
                        if (url.includes('.m3u8') || ct.includes('mpegurl')) {
                            const name = `VIPBox Embed ${getQuality(url)}`;
                            if (!capturedStreams.has(url)) {
                                capturedStreams.set(url, {
                                    url, name, title: name,
                                    behaviorHints: { notWebReady: false }
                                });
                            }
                        }
                    });
                    await iframePage.goto(src, { waitUntil: 'networkidle2', timeout: 20000 });
                    await new Promise(r => setTimeout(r, 3000));
                    await iframePage.close();
                }
            } catch (e) {
                console.error('iframe error:', e.message);
            }
        }

        // Get poster image from the page while we're here
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
        console.error('Puppeteer scrape error:', e.message);
        return { streams: [], poster: null };
    } finally {
        await page.close();
    }
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
    version: '4.0.0',
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
            extra: [{ name: 'search', isRequired: false }]
        }
    ]
});

// ── Catalog ───────────────────────────────────────────────────────────────────
builder.defineCatalogHandler(async (args) => {
    try {
        let events;
        if (args.extra && args.extra.search) {
            events = await searchEvents(args.extra.search);
        } else {
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

// ── Meta ──────────────────────────────────────────────────────────────────────
builder.defineMetaHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { meta: null };

    const parts = args.id.replace('vipbox:', '').split(':');
    const slug = parts[parts.length - 1];
    const name = slug
        .replace(/-streams$/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    // Try to get poster from cache if stream was already fetched
    const cleanId = args.id.replace(/:1:1$/, '');
    const path = cleanId.replace('vipbox:', '').replace(/:/g, '/');
    const eventUrl = `${BASE_URL}/${path}`;
    const streamCache = fromCache(`streams:${eventUrl}`, 2 * 60 * 1000);
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

// ── Stream ────────────────────────────────────────────────────────────────────
builder.defineStreamHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { streams: [] };

    const cleanId = args.id.replace(/:1:1$/, '');
    const path = cleanId.replace('vipbox:', '').replace(/:/g, '/');
    const eventUrl = `${BASE_URL}/${path}`;

    try {
        const { streams } = await scrapeStreamsWithPuppeteer(eventUrl);
        return { streams };
    } catch (e) {
        console.error('Stream error:', e.message);
        return { streams: [] };
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Warm up browser on startup
getBrowser().then(() => console.log('Headless browser ready'));

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`VIPBox Live Sports addon running on port ${PORT}`);
