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

// Known CDN/stream domains used by VIPBox and similar sites
// Add more here if you find them with the Tampermonkey script
const STREAM_DOMAINS = [
    'strmd.top',
    'strmd.net',
    'streamhls.top',
    'hlsstream.top',
    'cdn.streamed',
    'live.streamed',
    'streamjc.com',
    'streamjockey',
    'vipstreams',
    'streamtp',
    'playerjs',
];

// Regex patterns to find stream URLs in page source
const STREAM_PATTERNS = [
    // strmd.top style: /secure/TOKEN/rtmp/stream/CHANNEL/1/playlist.m3u8
    /https?:\/\/[^"'\s]+\/secure\/[^"'\s]+\/[^"'\s]+\.m3u8/gi,
    // Generic m3u8 with token params
    /https?:\/\/[^"'\s]+\.m3u8\?(?:token|auth|key|sig|hash)=[^"'\s]*/gi,
    // Generic m3u8
    /https?:\/\/[^"'\s]+playlist\.m3u8[^"'\s]*/gi,
    /https?:\/\/[^"'\s]+index\.m3u8[^"'\s]*/gi,
    /https?:\/\/[^"'\s]+master\.m3u8[^"'\s]*/gi,
    // PlayerJS file sources
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

// ── Plain fetch for listing pages ─────────────────────────────────────────────
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

// ── Extract all stream URLs from a block of text ──────────────────────────────
function extractStreamUrls(text) {
    const found = new Set();
    for (const pattern of STREAM_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = [...text.matchAll(pattern)];
        for (const m of matches) {
            // m[1] is the capture group if present, otherwise m[0]
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

// ── Connect to Browserless ────────────────────────────────────────────────────
async function getBrowser() {
    return puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}&stealth=true`,
    });
}

// ── Open a page, intercept network + scan source for stream URLs ──────────────
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

    // Network interception — catch m3u8 requests live as they fire
    page.on('request', req => {
        const url = req.url();
        const urls = extractStreamUrls(url);
        urls.forEach(u => {
            console.log(`[${label}] 🎯 Network request: ${u}`);
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
            console.log(`[${label}] 🎯 Network response: ${url}`);
            intercepted.add(url);
        }
    });

    let iframeSrcs = [];

    try {
        await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        // Try clicking a play button if present
        try {
            await page.click('.play-button, .vjs-big-play-button, .fp-play, [class*="play-btn"], [id*="play"]');
            console.log(`[${label}] Clicked play button`);
            await new Promise(r => setTimeout(r, 4000));
        } catch (_) {}

        // Scan all inline script content for stream URLs
        const scriptTexts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('script:not([src])')).map(s => s.innerHTML).join('\n')
        );
        const fromScripts = extractStreamUrls(scriptTexts);
        fromScripts.forEach(u => {
            console.log(`[${label}] 📄 Found in scripts: ${u}`);
            intercepted.add(u);
        });

        // Also scan full page HTML
        const pageHtml = await page.content();
        const fromHtml = extractStreamUrls(pageHtml);
        fromHtml.forEach(u => {
            console.log(`[${label}] 📄 Found in HTML: ${u}`);
            intercepted.add(u);
        });

        // Collect iframe sources for the caller to follow
        iframeSrcs = await page.$$eval('iframe', els =>
            els.map(el => el.src || el.getAttribute('data-src') || '').filter(s => s.startsWith('http'))
        );
        console.log(`[${label}] Found ${iframeSrcs.length} iframes`);

    } catch (e) {
        console.error(`[${label}] Page error:`, e.message);
    } finally {
        await page.close();
    }

    return { urls: [...intercepted], iframeSrcs };
}

// ── Main scraper: event page → iframes → nested iframes ──────────────────────
async function scrapeStreams(eventUrl) {
    const cacheKey = `streams:${eventUrl}`;
    const cached = fromCache(cacheKey, 2 * 60 * 1000);
    if (cached) return cached;

    if (!BROWSERLESS_TOKEN) return { streams: [] };

    const browser = await getBrowser();
    const allUrls = new Set();

    try {
        // Level 1: main event page
        const { urls: mainUrls, iframeSrcs } = await extractFromPage(browser, eventUrl, BASE_URL, 'MAIN');
        mainUrls.forEach(u => allUrls.add(u));

        // Level 2: iframes on the event page
        for (const src of iframeSrcs.slice(0, 5)) {
            const { urls: embedUrls, iframeSrcs: nestedSrcs } = await extractFromPage(browser, src, eventUrl, 'IFRAME');
            embedUrls.forEach(u => allUrls.add(u));

            // Level 3: nested iframes (some players are double-embedded)
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

        console.log(`✅ Total streams found for ${eventUrl}: ${streams.length}`);
        streams.forEach(s => console.log('  -', s.url));

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

// ── Addon ─────────────────────────────────────────────────────────────────────
const builder = new addonBuilder({
    id: 'org.vipbox.allsports',
    version: '7.0.0',
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
