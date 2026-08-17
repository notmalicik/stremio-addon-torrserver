const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

// --- NETWORK MONITOR ---
app.use((req, res, next) => {
    if (!req.url.includes("/manifest.json") && !req.url.includes("/catalog/")) {
        console.log(`📡 [NETWORK] Request: ${req.method} ${req.url}`);
    }
    next();
});

// ==========================================
//             CONFIGURATION
// ==========================================
const PORT = process.env.PORT || 7000;
const ADDON_PUBLIC_IP = process.env.ADDON_PUBLIC_IP || "0.0.0.0";
const ADDON_URL = `http://${ADDON_PUBLIC_IP}:${PORT}`;

const JACKETT_URL = process.env.JACKETT_URL || "https://jac.red";
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || "null";

const TORRSERVER_HOST = process.env.TORRSERVER_HOST || "localhost:9090";
const TORRSERVER_USER = process.env.TORRSERVER_USER || "username";
const TORRSERVER_PASS = process.env.TORRSERVER_PASS || "password";
// ==========================================

const TORRSERVER_AUTH_URL = TORRSERVER_USER
    ? `http://${TORRSERVER_USER}:${TORRSERVER_PASS}@${TORRSERVER_HOST}`
    : `http://${TORRSERVER_HOST}`;

// --- CACHE SYSTEM ---
const jackettCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

const REQUEST_DELAY = 1100;
let lastRequestTime = 0;
const requestQueue = [];

async function rateLimitedRequest(url) {
    const now = Date.now();
    const wait = Math.max(0, REQUEST_DELAY - (now - lastRequestTime));
    if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
    }
    lastRequestTime = Date.now();
    return axios.get(url);
}

async function axiosWithRetry(url, retries = 3, baseDelay = 2000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await rateLimitedRequest(url);
        } catch (err) {
            const status = err.response?.status;
            if (status === 429 && attempt < retries) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.warn(`⏳ Jackett 429 (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
}

async function searchJackettV1(query, cacheKey) {
    const cached = jackettCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.data;
    }

    const url = `${JACKETT_URL}/api/v1.0/torrents?search=${encodeURIComponent(query)}&apikey=${JACKETT_API_KEY}`;
    try {
        const response = await axiosWithRetry(url);
        const results = ensureArray(response.data);
        jackettCache.set(cacheKey, { timestamp: Date.now(), data: results });
        return results;
    } catch (err) {
        const status = err.response?.status || "N/A";
        console.error(`❌ Jackett v1 search error (${status}): ${err.message}`);
        return [];
    }
}

async function searchJackettV1ByName(title) {
    return searchJackettV1(title, `name_${title.toLowerCase().trim()}`);
}

async function searchJackettV1ByImdbId(imdbId) {
    return searchJackettV1(imdbId.trim(), `imdb_${imdbId.trim()}`);
}

async function searchJackettV2ByName(title) {
    const cacheKey = `name_v2_${title.toLowerCase().trim()}`;
    const cached = jackettCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        return cached.data;
    }

    const url = `${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&query=${encodeURIComponent(title)}`;
    try {
        const response = await axiosWithRetry(url);
        const results = ensureArray(response.data);
        jackettCache.set(cacheKey, { timestamp: Date.now(), data: results });
        return results;
    } catch (err) {
        const status = err.response?.status || "N/A";
        console.error(`❌ Jackett v2 search error (${status}): ${err.message}`);
        return [];
    }
}

function ensureArray(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.Results)) return data.Results;
    if (data && Array.isArray(data.results)) return data.results;
    if (data && typeof data === "object") return [data];
    return [];
}

function getResolutionRank(torrent) {
    if (!torrent) return 0;
    const qualityVal = (torrent.info && torrent.info.quality) || torrent.quality;

    const title = (torrent.Title || torrent.title || torrent.name || "").toLowerCase();

    if (qualityVal && parseInt(qualityVal) >= 2160) return 3;
    if (qualityVal && parseInt(qualityVal) >= 1080) return 2;

    if (title.includes("2160p") || title.includes("4k") || title.includes("uhd") || title.includes("4320p")) return 3;
    if (title.includes("1080p") || title.includes("fhd") || title.includes("fullhd") || title.includes("1080")) return 2;
    if (title.includes("720p") || title.includes("hd")) return 1;
    return 0;
}

function getResolutionLabel(torrent) {
    const rank = getResolutionRank(torrent);
    if (rank >= 3) return "4K";
    if (rank === 2) return "1080p";
    if (rank === 1) return "720p";
    return "SD";
}
app.get("/resolve", async (req, res) => {
    const { link, season, episode } = req.query;
    if (!link) return res.status(400).send("Missing link");

    console.log(`🎯 [Resolve] Processing torrent. Season ${season}, Episode ${episode}`);

    try {
        // Add torrent to TorrServer
        const addResponse = await axios.post(`${TORRSERVER_AUTH_URL}/torrents`, {
            action: "add",
            link: link
        });
        const hash = addResponse.data.hash;

        // Wait for metadata
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Get file list
        const torrentInfo = await axios.post(`${TORRSERVER_AUTH_URL}/torrents`, {
            action: "get",
            hash: hash
        });
        const files = torrentInfo.data.file_stats || [];

        let fileIndex = null;
        if (season && episode) {
            // Find file matching season/episode
            const regex = new RegExp(`S0*${season}E0*${episode}`, "i");
            const found = files.find(f => regex.test(f.path));
            if (found) fileIndex = found.id;
        }

        // Build final stream URL
        let streamUrl = `${TORRSERVER_AUTH_URL}/stream?link=${encodeURIComponent(link)}&play=true`;
        if (fileIndex !== null) streamUrl += `&index=${fileIndex}`;

        console.log(`✅ [Resolve] Redirecting to: ${streamUrl}`);
        res.redirect(streamUrl);
    } catch (err) {
        console.error("❌ [Resolve] Error:", err.message);
        res.status(500).send("Error processing torrent");
    }
});
function getTorrentSeasons(torrent) {
    const seasons = (torrent.info && torrent.info.seasons) || torrent.seasons;
    if (Array.isArray(seasons)) return seasons;
    if (seasons === null || seasons === undefined || seasons === "") return null;
    return [seasons];
}

function matchesSeasonAndEpisode(torrent, season, episode) {
    if (!torrent) return false;
    const title = (torrent.Title || torrent.title || torrent.name || "").toLowerCase();
    const s = parseInt(season);
    const e = parseInt(episode);

    const seasonsArray = getTorrentSeasons(torrent);
    if (seasonsArray && seasonsArray.includes(s)) {
        return true;
    }

    const standardMatch = new RegExp(`s0*${s}\\s*[e\\.]\\s*0*${e}\\b`, 'i').test(title);
    const crossMatch = new RegExp(`\\b0*${s}x0*${e}\\b`, 'i').test(title);
    if (standardMatch || crossMatch) return true;

    const ruMatch = new RegExp(`(?:сезон|season)[\\s_]*0*${s}.*?(?:серия|эпизод|ep|с)[\\s_]*0*${e}\\b`, 'i').test(title);
    if (ruMatch) return true;

    const seasonPackRu = new RegExp(`(?:сезон|season|s)\\s*0*${s}\\b`, 'i').test(title);
    if (seasonPackRu) return true;

    return false;
}

async function getCinemetaMeta(type, imdbId) {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        const res = await axios.get(url);
        if (res.data && res.data.meta) return res.data.meta;
    } catch (e) { }
    return null;
}

function cleanTitle(title) {
    return title ? title.replace(/[:']/g, "").trim() : "";
}

// =====================================================================
// ADDON BUILDER
// =====================================================================
const builder = new addonBuilder({
    id: "org.jacred.torrserver",
    version: "2.13.1",
    name: "Jac.red + TorrServer",
    description: "Streaming rapid FHD prin TorrServer.",
    catalogs: [],
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"]
});
/// Calculate absolute episode index based on Cinemeta episode list
function getAbsoluteEpisodeIndex(videos, targetSeason, targetEpisode) {
    if (!Array.isArray(videos)) return targetEpisode;

    let index = 0;
    for (const v of videos) {
        if (v.season === targetSeason && v.episode === targetEpisode) {
            return index + 1;
        }
        if (v.season > 0) {
            index++;
        }
    }
    return targetEpisode;
}
/// Calculate episode index within the torrent's own season range
function getTorrentEpisodeIndex(videos, torrent, targetSeason, targetEpisode) {
    const s = parseInt(targetSeason);
    const e = parseInt(targetEpisode);

    const seasonsArray = getTorrentSeasons(torrent);

    // Single-season torrent: no cumulative increment needed
    if (seasonsArray && seasonsArray.length === 1) {
        return e;
    }

    // Multi-season torrent: count only the episodes of the seasons it contains
    if (Array.isArray(videos) && Array.isArray(seasonsArray)) {
        const seasonSet = new Set(seasonsArray.map(Number));
        let index = 0;
        for (const v of videos) {
            const vs = Number(v.season);
            if (vs === s && Number(v.episode) === e) {
                return index + 1;
            }
            if (seasonSet.has(vs)) {
                index++;
            }
        }
    }

    // Unknown seasons (e.g. v2 fallback): absolute Cinemeta index
    return getAbsoluteEpisodeIndex(videos, s, e);
}
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0; // 32-bit integer
    }
    return Math.abs(hash).toString(36);
}

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n▶️ Stremio searching ${type}: ${id}`);

    const streams = [];

    const [imdbId, season, episode] = id.split(":");
    const s = parseInt(season);
    const e = parseInt(episode);

    const meta = await getCinemetaMeta(type, imdbId);
    if (!meta || !meta.name) {
        console.log(`❌ Could not find title in Cinemeta for ID: ${imdbId}`);
        return { streams: [] };
    }

    const titleQuery = cleanTitle(meta.name);
    console.log(`🔍 Searching Jackett v1 by name: "${titleQuery}"`);

    let rawResults = await searchJackettV1ByName(titleQuery);
    console.log(`📦 Jackett v1 returned ${rawResults.length} raw torrents (by name).`);

    if (rawResults.length === 0) {
        console.log(`🔍 No v1 results by name, trying v1 by IMDb ID: "${imdbId}"`);
        rawResults = await searchJackettV1ByImdbId(imdbId);
        console.log(`📦 Jackett v1 returned ${rawResults.length} raw torrents (by ID).`);
    }

    if (rawResults.length === 0) {
        console.log(`🔍 No v1 results, falling back to Jackett v2 by name: "${titleQuery}"`);
        rawResults = await searchJackettV2ByName(titleQuery);
        console.log(`📦 Jackett v2 returned ${rawResults.length} raw torrents (fallback).`);
    }

    let filteredResults = ensureArray(rawResults).filter(torrent => torrent && (torrent.Title || torrent.title));

    filteredResults = filteredResults.filter(torrent => {
        const title = (torrent.Title || torrent.title || torrent.name || "").toLowerCase();
        const ukrPattern = /(?:українськ|украинск|україн|ukr|ukrainian|dub\s*\(?\s*ua\b|\(uk\b|uk\s*dub|voice\s*over\s*ua\b|ua\s*audio)/i;
        return !ukrPattern.test(title);
    });

    if (type === "series") {
        filteredResults = filteredResults.filter(torrent => matchesSeasonAndEpisode(torrent, season, episode));
    }

    filteredResults = filteredResults.filter(torrent => {
        const link = torrent.MagnetUri || torrent.magnet || torrent.Link || torrent.Guid;
        return link && typeof link === "string" && link.length > 10;
    });

    filteredResults.sort((a, b) => {
        const rankDiff = (getResolutionRank(b) || 0) - (getResolutionRank(a) || 0);
        if (rankDiff !== 0) return rankDiff;
        return (b.Seeders || b.sid || 0) - (a.Seeders || a.sid || 0);
    });

    console.log(`✅ ${filteredResults.length} sources remaining (sorted: 4K > 1080p > rest).`);

    for (const torrent of filteredResults) {
        const torrentLink = torrent.MagnetUri || torrent.magnet || torrent.Link || torrent.Guid;
        const torrentTitle = torrent.Title || torrent.title || torrent.name || "Unknown";
        const seeders = torrent.Seeders || torrent.sid || 0;
        const trackerName = (torrent.Tracker || torrent.tracker) ? `[${torrent.Tracker || torrent.tracker}] ` : "";

        let torrentIndex = 1;
        if (type === "series" && season && episode) {
            torrentIndex = getTorrentEpisodeIndex(meta.videos, torrent, s, e);
        }

        let directStreamUrl = `${TORRSERVER_AUTH_URL}/stream?link=${encodeURIComponent(torrentLink)}&play=true`;

        if (type === "series" && season && episode) {
            directStreamUrl += `&index=${torrentIndex}`;
        }
        const binge = "jacred-" + simpleHash(torrentLink);
        console.log(`📌${id} Stream: ${torrentTitle.substring(0, 50)} | index=${torrentIndex} | bingeGroup=${binge} | magnet hash=${simpleHash(torrentLink)}`);
        const resLabel = getResolutionLabel(torrent);
        streams.push({
            name: `TorrStream\n${resLabel}`,
            title: `💎 ${trackerName}${torrentTitle}\n👤 Seeders: ${seeders}`,
            url: directStreamUrl,
            behaviorHints: {
                bingeGroup: "jacred-" + simpleHash(torrentLink)
            }
        });

    }
    console.log(`📡 Stream request: ${id}, streams returned: ${streams.length}`);

    return { streams };
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`version: 2.13.1`);
    console.log(`🚀 Add-on running at ${ADDON_URL}`);
    console.log(`👉 Install link: ${ADDON_URL}/manifest.json`);
});