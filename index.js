const { addonBuilder, serveHTTP } = require('@stremio/addon-sdk');
const cheerio = require('cheerio');

const builder = new addonBuilder({
    id: 'org.m3u8.hunter',
    version: '1.0.0',
    name: 'M3U8 Hunter',
    description: 'VIPBOX UFC/WWE HLS streams with tokens',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: ['vipbox']
});

builder.defineCatalogHandler(async (args) => {
    if (args.extra.search) {
        return { metas: [] };
    }
    return {
        metas: [{
            id: 'vipbox:category:ufc',
            name: 'UFC/WWE Live',
            type: 'series',
            poster: 'https://i.imgur.com/ufc-logo.png'
        }]
    };
});

builder.defineMetaHandler(async (args) => {
    if (args.id === 'vipbox:category:ufc') {
        return {
            meta: {
                id: 'vipbox:category:ufc',
                name: 'UFC/WWE Live Streams',
                type: 'series',
                poster: 'https://i.imgur.com/ufc-logo.png',
                videos: [{
                    season: 1,
                    episode: 1,
                    id: 'vipbox:category:ufc:1:1',
                    title: 'Live Events'
                }]
            }
        };
    }
    return { meta: null };
});

builder.defineStreamHandler(async (args) => {
    if (!args.id.startsWith('vipbox:category:ufc')) return { streams: [] };

    try {
        const streams = await scrapeVipboxStreams();
        return { streams };
    } catch (e) {
        console.error('Scrape failed:', e);
        return { streams: [] };
    }
});

async function scrapeVipboxStreams() {
    const sites = [
        'https://vipbox.lc',
        'https://vipboxed.eu',
        'https://vipbox.sx'
    ];
    
    const streams = [];
    
    for (const site of sites) {
        try {
            const m3u8s = await extractM3U8Tokens(site);
            streams.push(...m3u8s);
        } catch (e) {
            console.error(`Failed ${site}:`, e.message);
        }
    }
    
    return streams.filter(isValidHLS);
}

async function extractM3U8Tokens(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const res = await fetch(url, { 
        signal: controller.signal 
    });
    clearTimeout(timeout);
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const html = await res.text();
    const $ = cheerio.load(html);
    
    const streams = [];
    
    // Method 1: Direct script m3u8 links with tokens
    $('script').each((i, elem) => {
        const content = $(elem).html() || '';
        const m3u8Matches = [...content.matchAll(/https?:\/\/[^"\s]+\.m3u8(?:\?[^"\s]*)?/gi)];
        
        m3u8Matches.forEach(match => {
            const url = match[0];
            if (url.includes('token=') || url.includes('key=') || url.includes('auth=')) {
                streams.push({
                    url,
                    title: `VIPBOX HLS ${url.includes('token') ? 'Token' : 'Auth'}`,
                    name: `VIPBOX ${getQuality(url)}`
                });
            }
        });
    });
    
    // Method 2: Embedded player sources (Network Tab emulation)
    const playerSources = $('iframe[src*="embed"], .player source, video source')
        .map((i, el) => $(el).attr('src') || $(el).data('src'))
        .get();
    
    for (const src of playerSources) {
        if (src && src.includes('.m3u8')) {
            streams.push({
                url: src,
                title: 'Player HLS',
                name: 'VIPBOX Embedded'
            });
        }
    }
    
    return streams.slice(0, 5); // Limit per site
}

function getQuality(url) {
    if (url.includes('1080') || url.includes('fullhd')) return '1080p';
    if (url.includes('720')) return '720p';
    return 'HLS';
}

function isValidHLS(stream) {
    return stream.url && stream.url.includes('.m3u8') && 
           !stream.url.includes('demo') && 
           !stream.url.includes('sample');
}

serveHTTP(builder.getInterface(), async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    try {
        await builder.serve(req, res);
    } catch (e) {
        console.error('Serve error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});
