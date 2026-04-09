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

const STREAM_PATTERNS = [
    /https?:\/\/[^"'\s]+\/secure\/[^"'\s]+\/[^"'\s]+\.m3u8/gi,
    /https?:\/\/[^"'\s]+\.m3u8\?(?:token|auth|key|sig|hash)=[^"'\s]*/gi,
    /https?:\/\/[^"'\s]+playlist\.m3u8[^"'\s]*/gi,
    /https?:\/\/[^"'\s]+index\.m3u8[^"'\s]*/gi,
    /https?:\/\/[^"'\s]+master\.m3u8[^"'\s]*/gi,
    /file\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/gi,
    /source\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/gi,
    /["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/gi,
];

// ── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
function fromCache(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}
function toCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Plain fetch ───────────────────────────────────────────────────────────────
async function fetchHtml(url, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': BASE_URL,
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// ── Extract stream URLs from text ─────────────────────────────────────────────
function extractStreamUrls(text) {
    const found = new Set();
    for (const pattern of STREAM_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = [...text.matchAll(pattern)];
        for (const m of matches) {
            const url = (m[1] || m[0]).trim().replace(/['"` ]/g, '');
            if (
                url.startsWith('http') &&
                url.includes('.m3u8') &&
                !url.includes('demo') &&
                !url.includes('sample') &&
                !url.includes('test.m3u8')
            ) {
                found.add(url);
            }
        }
    }
    return [...found];
}

// ── Browserless connection ────────────────────────────────────────────────────
async function getBrowser() {
    return puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}&stealth=true`,
    });
}

// ── Scrape a single page for stream URLs ─────────────────────────────────────
async function extractFromPage(browser, pageUrl, referer, label) {
    const page = await browser.newPage();
    const intercepted = new Set();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': referer || BASE_URL,
    });
    await page.setRequestInterception(true);

    page.on('request', req => {
        const url = req.url();
        extractStreamUrls(url).forEach(u => {
            console.log(`[${label}] 🎯 Network: ${u}`);
            intercepted.add(u);
        });
        if (['image', 'font', 'stylesheet'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    page.on('response', async response => {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (url.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('x-mpegURL')) {
            console.log(`[${label}] 🎯 Response: ${url}`);
            intercepted.add(url);
        }
    });

    let iframeSrcs = [];

    try {
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        try {
            await page.click('.play-button, .vjs-big-play-button, .fp-play, [class*="play-btn"], [id*="play"]');
            await new Promise(r => setTimeout(r, 4000));
        } catch (_) {}

        const scriptTexts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('script:not([src])')).map(s => s.innerHTML).join('\n')
        );
        extractStreamUrls(scriptTexts).forEach(u => {
            console.log(`[${label}] 📄 Script: ${u}`);
            intercepted.add(u);
        });

        const pageHtml = await page.content();
        extractStreamUrls(pageHtml).forEach(u => {
            console.log(`[${label}] 📄 HTML: ${u}`);
            intercepted.add(u);
        });

        iframeSrcs = await page.$$eval('iframe', els =>
            els.map(el => el.src || el.getAttribute('data-src') || '').filter(s => s.startsWith('http'))
        );

    } catch (e) {
        console.error(`[${label}] Error:`, e.message);
    } finally {
        await page.close();
    }

    return { urls: [...intercepted], iframeSrcs };
}

// ── Main stream scraper ───────────────────────────────────────────────────────
async function scrapeStreams(eventUrl) {
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey, 2 * 60 * 1000);
    if (cached) return cached;

    if (!BROWSERLESS_TOKEN) return { streams: [] };

    const browser = await getBrowser();
    const allUrls = new Set();

    try {
        const { urls: mainUrls, iframeSrcs } = await extractFromPage(browser, eventUrl, BASE_URL, 'MAIN');
        mainUrls.forEach(u => allUrls.add(u));

        for (const src of iframeSrcs.slice(0, 5)) {
            const { urls: embedUrls, iframeSrcs: nestedSrcs } = await extractFromPage(browser, src, eventUrl, 'IFRAME');
            embedUrls.forEach(u => allUrls.add(u));

            for (const nested of nestedSrcs.slice(0, 3)) {
                const { urls: nestedUrls } = await extractFromPage(browser, nested, src, 'NESTED');
                nestedUrls.forEach(u => allUrls.add(u));
            }
        }

        const streams = [...allUrls].map(url => ({
            url,
            name: `VIPBox ${getQuality(url)}`,
            title: `VIPBox ${getQuality(url)}`,
            behaviorHints: { notWebReady: false }
        }));

        console.log(`✅ Streams found: ${streams.length}`);
        const result = { streams };
        toCache(cacheKey, result);
        return result;

    } catch (e) {
        console.error('Scrape error:', e.message);
        return { streams: [] };
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

// ── Events scraper ────────────────────────────────────────────────────────────
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

function eventToMeta(ev) {
    return {
        id: ev.id,
        type: 'series',
        name: ev.title,
        poster: 'https://www.vipbox.lc/img/vipbox.svg',
        description: `Live on VIPBox: ${ev.title}`
    };
}

// ── Parse event URL back from a stream request ID ─────────────────────────────
// Stream handler receives IDs like:
//   vipbox:wwe:wwe-nxt-streams:1:1   (with season:episode suffix)
//   vipbox:wwe:wwe-nxt-streams       (without suffix)
// We need to reconstruct: https://www.vipbox.lc/wwe/wwe-nxt-streams
function idToEventUrl(id) {
    // Strip trailing :SEASON:EPISODE if present (one or two numeric segments at the end)
    const clean = id.replace(/:(\d+):(\d+)$/, '').replace(/:(\d+)$/, '');
    // Strip the vipbox: prefix and convert remaining colons to slashes
    const path = clean.replace(/^vipbox:/, '').replace(/:/g, '/');
    return `${BASE_URL}/${path}`;
}

// ── Addon ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.vipbox.allsports',
    version: '9.0.0',
    name: 'VIPBox Live Sports',
    description: 'Browse and search live sports streams from VIPBox',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: ['vipbox'],
    catalogs: [
        {
            // Discover page category
            type: 'series',
            id: 'vipbox_live',
            name: 'VIPBox Live Sports',
            extra: [
                { name: 'skip' }
            ]
        },
        {
            // Search bar
            type: 'series',
            id: 'vipbox_search',
            name: 'VIPBox Live Sports',
            extra: [
                { name: 'search', isRequired: true }
            ]
        }
    ]
});

// ── Catalog ───────────────────────────────────────────────────────────────────
builder.defineCatalogHandler(async (args) => {
    try {
        if (args.id === 'vipbox_search') {
            const query = args.extra && args.extra.search;
            if (!query) return { metas: [] };
            const events = await searchEvents(query);
            return { metas: events.slice(0, 100).map(eventToMeta) };
        }

        if (args.id === 'vipbox_live') {
            const events = await getAllEvents();
            const skip = parseInt((args.extra && args.extra.skip) || 0);
            return { metas: events.slice(skip, skip + 50).map(eventToMeta) };
        }

        return { metas: [] };
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

    // Video ID must match exactly what the stream handler will receive
    const videoId = `${args.id}:1:1`;

    return {
        meta: {
            id: args.id,
            type: 'series',
            name,
            poster: 'https://www.vipbox.lc/img/vipbox.svg',
            description: `Watch ${name} live on VIPBox`,
            videos: [{
                id: videoId,
                title: 'Live Stream',
                season: 1,    // Must be 1, not 0
                episode: 1,
                released: new Date().toISOString()
            }]
        }
    };
});

// ── Stream ────────────────────────────────────────────────────────────────────
builder.defineStreamHandler(async (args) => {
    if (!args.id.startsWith('vipbox:')) return { streams: [] };

    console.log('Stream request for ID:', args.id);

    const eventUrl = idToEventUrl(args.id);
    console.log('Resolved event URL:', eventUrl);

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
