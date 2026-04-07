const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');

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

// ── Plain fetch for catalog pages ─────────────────────────────────────────────
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

// ── Connect to Browserless ────────────────────────────────────────────────────
async function getBrowser() {
    return puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}&stealth=true`,
    });
}

// ── Scrape a single page with Puppeteer, log EVERY network request ────────────
async function scrapePageForM3U8(browser, url, label) {
    const page = await browser.newPage();
    const found = new Map();
    const allRequests = [];

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setRequestInterception(true);

    page.on('request', req => {
        const u = req.url();
        allRequests.push(u);

        if (u.includes('.m3u8') || u.includes('playlist') || u.includes('manifest')) {
            console.log(`[${label}] 🎯 Possible stream request: ${u}`);
            found.set(u, { url: u, name: `VIPBox ${getQuality(u)}`, title: `VIPBox ${getQuality(u)}`, behaviorHints: { notWebReady: false } });
        }

        if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on('response', async response => {
        const u = response.url();
        const ct = response.headers()['content-type'] || '';
        if (u.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegURL')) {
            console.log(`[${label}] 🎯 Stream response detected: ${u} (${ct})`);
            found.set(u, { url: u, name: `VIPBox ${getQuality(u)}`, title: `VIPBox ${getQuality(u)}`, behaviorHints: { notWebReady: false } });
        }
    });

    try {
        console.log(`[${label}] Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 6000));

        // Log ALL requests made so we can see what the page is calling
        console.log(`[${label}] All network requests (${allRequests.length} total):`);
        allRequests.forEach(u => {
            // Only log non-trivial requests
            if (!u.includes('google') && !u.includes('favicon') && !u.includes('analytics')) {
                console.log(`  -> ${u}`);
            }
        });

        // Try clicking any play button that might trigger the stream
        try {
            await page.click('.play-button, .vjs-big-play-button, button[class*="play"], [id*="play"], .fp-play');
            console.log(`[${label}] Clicked play button`);
            await new Promise(r => setTimeout(r, 4000));
        } catch (_) {
            console.log(`[${label}] No play button found`);
        }

        // Dump any script content that contains 'file' or 'source' or 'stream'
        const scriptContent = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script:not([src])'));
            return scripts.map(s => s.innerHTML).join('\n');
        });

        // Look for stream URLs in JS variables
        const urlPatterns = [
            /["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/gi,
            /["'](https?:\/\/[^"']+playlist[^"']*)['"]/gi,
            /file\s*:\s*["'](https?:\/\/[^"']+)['"]/gi,
            /source\s*:\s*["'](https?:\/\/[^"']+)['"]/gi,
            /src\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/gi,
            /url\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/gi,
        ];

        for (const pattern of urlPatterns) {
            const matches = [...scriptContent.matchAll(pattern)];
            matches.forEach(m => {
                const u = m[1];
                console.log(`[${label}] 📄 Found in script: ${u}`);
                if (!found.has(u)) {
                    found.set(u, { url: u, name: `VIPBox Script ${getQuality(u)}`, title: `VIPBox Script ${getQuality(u)}`, behaviorHints: { notWebReady: false } });
                }
            });
        }

        // Get all iframe srcs
        const iframeSrcs = await page.$$eval('iframe', els =>
            els.map(el => el.src || el.getAttribute('data-src')).filter(s => s && s.startsWith('http'))
        );
        console.log(`[${label}] Found ${iframeSrcs.length} iframes:`, iframeSrcs);

        return { found: [...found.values()], iframeSrcs };

    } finally {
        await page.close();
    }
}

// ── Main stream scraper ───────────────────────────────────────────────────────
async function scrapeStreams(eventUrl) {
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey, 2 * 60 * 1000);
    if (cached) return cached;

    if (!BROWSERLESS_TOKEN) return { streams: [], poster: null };

    const browser = await getBrowser();
    const allStreams = new Map();

    try {
        // Step 1: scrape the main event page
        const { found: mainFound, iframeSrcs } = await scrapePageForM3U8(browser, eventUrl, 'MAIN');
        mainFound.forEach(s => allStreams.set(s.url, s));

        // Step 2: follow every iframe
        for (const src of iframeSrcs.slice(0, 5)) {
            try {
                const { found: embedFound, iframeSrcs: nestedSrcs } = await scrapePageForM3U8(browser, src, 'IFRAME');
                embedFound.forEach(s => allStreams.set(s.url, s));

                // Step 3: follow nested iframes (players sometimes have 2 levels)
                for (const nested of nestedSrcs.slice(0, 3)) {
                    try {
                        const { found: nestedFound } = await scrapePageForM3U8(browser, nested, 'NESTED');
                        nestedFound.forEach(s => allStreams.set(s.url, s));
                    } catch (e) {
                        console.error('Nested iframe error:', e.message);
                    }
                }
            } catch (e) {
                console.error('Iframe error:', e.message);
            }
        }

        const streams = [...allStreams.values()]
            .filter(s => !s.url.includes('demo') && !s.url.includes('sample'))
            .slice(0, 10);

        console.log(`Final streams found: ${streams.length}`);
        streams.forEach(s => console.log(' -', s.url));

        const result = { streams, poster: null };
        toCache(cacheKey, result);
        return result;

    } catch (e) {
        console.error('Scrape error:', e.message);
        return { streams: [], poster: null };
    } finally {
        await browser.disconnect();
    }
}

function getQuality(url) {
    if (url.includes('1080') || url.includes('fullhd')) return '1080p';
    if (url.includes('720')) return '720p';
    if (url.includes('480')) return '480p';
    return 'HLS';
}

// ── Scrape all events ─────────────────────────────────────────────────────────
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

// ── Addon ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.vipbox.allsports',
    version: '6.0.0',
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
