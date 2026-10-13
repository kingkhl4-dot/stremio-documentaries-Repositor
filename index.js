const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

const TMDB_KEY = process.env.TMDB_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const IMG = "https://image.tmdb.org/t/p/";
const PREFIX = "doc:";
const extra = [{ name: "search" }, { name: "skip" }];

const manifest = {
  id: "community.documentaries.ar",
  version: "1.0.0",
  name: "مكتبة الوثائقيات",
  description: "أفلام ومسلسلات وثائقية مع معلومات عربية",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: [PREFIX],
  catalogs: [
    { type: "movie", id: "doc-movies", name: "أفلام وثائقية", extra },
    { type: "series", id: "doc-series", name: "مسلسلات وثائقية", extra }
  ]
};

const builder = new addonBuilder(manifest);
const idCache = new Map();
const trCache = new Map();

async function tmdb(path, params = "", lang = "ar") {
  const url = `https://api.themoviedb.org/3${path}?api_key=${TMDB_KEY}&language=${lang}${params}`;
  return (await fetch(url)).json();
}

// Discover supported Flash models for this API key instead of relying on deprecated names.
let modelCache = { name: null, until: 0 };
async function getGeminiModel() {
  if (modelCache.name && Date.now() < modelCache.until) return modelCache.name;
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + GEMINI_API_KEY, { timeout: 7000 });
  if (!response.ok) throw new Error("Gemini model list HTTP " + response.status);
  const data = await response.json();
  const available = (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.startsWith("models/") ? m.name.slice(7) : m.name);
  const preferred = ["gemini-3.6-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3-flash-preview"];
  const chosen = preferred.find(n => available.includes(n)) || available.find(n => /flash/i.test(n));
  if (!chosen) throw new Error("No compatible Gemini Flash model available");
  modelCache = { name: chosen, until: Date.now() + 60 * 60 * 1000 };
  console.log("Gemini translation model:", chosen);
  return chosen;
}
const isArabic = (value) => {
  if (!value) return false;
  const arabic = (value.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return arabic > 0 && arabic >= latin;
};
let geminiQuotaBlockedUntil = 0;
const GEMINI_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;

async function toArabic(text) {
  if (!text || isArabic(text)) return text;
  if (!GEMINI_API_KEY || Date.now() < geminiQuotaBlockedUntil) return text;
  if (trCache.has(text)) return trCache.get(text);
  try {
    const model = await getGeminiModel();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ترجم الوصف التالي إلى العربية الفصحى المبسطة. أرجع الترجمة العربية فقط:\\n\\n" + text }] }],
          generationConfig: { temperature: 0.2 }
        })
      });
    } finally {
      clearTimeout(timeout);
    }
    if (res.status === 429) {
      geminiQuotaBlockedUntil = Date.now() + GEMINI_QUOTA_COOLDOWN_MS;
      console.log("Gemini rate limit reached: pausing translation requests for 15 minutes");
      return text;
    }
    if (!res.ok) {
      console.log("Gemini unavailable, status:", res.status);
      return text;
    }
    const data = await res.json();
    const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (isArabic(out)) {
      trCache.set(text, out);
      return out;
    }
  } catch (e) {
    console.log("Gemini request failed:", e.message);
  }
  return text; // Preserve source description if translation is unavailable.
}

async function getArabicDescription(kind, tmdbId, overview) {
  if (isArabic(overview)) return overview;
  const english = await tmdb(`/${kind}/${tmdbId}`, "", "en-US");
  return toArabic(english.overview || overview || "");
}

async function getEpisodes(tvId, imdb) {
  const show = await tmdb(`/tv/${tvId}`);
  const seasons = (show.seasons || []).filter((s) => s.season_number > 0);
  const results = await Promise.all(
    seasons.map((s) => tmdb(`/tv/${tvId}/season/${s.season_number}`))
  );
  const videos = [];
  for (const s of results) {
    for (const ep of s.episodes || []) {
      if (!ep.air_date) continue;
      videos.push({
        id: `${imdb}:${ep.season_number}:${ep.episode_number}`,
        title: ep.name || `الحلقة ${ep.episode_number}`,
        season: ep.season_number,
        episode: ep.episode_number,
        released: new Date(ep.air_date).toISOString(),
        thumbnail: ep.still_path ? IMG + "w300" + ep.still_path : undefined,
        overview: ep.overview
      });
    }
  }
  return videos;
}

builder.defineCatalogHandler(async ({ type, extra }) => {
  try {
    const kind = type === "movie" ? "movie" : "tv";
    const page = extra && extra.skip ? Math.floor(extra.skip / 20) + 1 : 1;
    const data =
      extra && extra.search
        ? await tmdb(`/search/${kind}`, `&query=${encodeURIComponent(extra.search)}&page=${page}`)
        : await tmdb(`/discover/${kind}`, `&with_genres=99&sort_by=popularity.desc&page=${page}`);

    const metas = await Promise.all(
      (data.results || []).filter(item => (item.genre_ids || []).includes(99)).map(async (item) => {
        const key = kind + item.id;
        let imdb = idCache.get(key);
        if (!imdb) {
          const ext = await tmdb(`/${kind}/${item.id}/external_ids`);
          imdb = ext.imdb_id;
          if (imdb) idCache.set(key, imdb);
        }
        if (!imdb) return null;
        return {
          id: PREFIX + imdb,
          type,
          name: item.title || item.name,
          description: item.overview,
          poster: item.poster_path ? IMG + "w500" + item.poster_path : undefined
        };
      })
    );
    return { metas: metas.filter(Boolean) };
  } catch (e) {
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const imdb = id.replace(PREFIX, "");
    const kind = type === "movie" ? "movie" : "tv";
    const data = await tmdb(`/find/${imdb}`, "&external_source=imdb_id");
    const found = type === "movie" ? data.movie_results[0] : data.tv_results[0];
    if (!found) return { meta: null };

    const item = await tmdb(`/${kind}/${found.id}`, "&append_to_response=credits");
    if (!(item.genres || []).some(g => g.id === 99)) return { meta: null };

        const description = await getArabicDescription(kind, found.id, item.overview);

    const date = item.release_date || item.first_air_date || "";
    const credits = item.credits || {};
    const director =
      type === "movie"
        ? (credits.crew || []).filter((c) => c.job === "Director").map((c) => c.name)
        : (item.created_by || []).map((c) => c.name);
    const runtime = type === "movie" ? item.runtime : (item.episode_run_time || [])[0];

    const meta = {
      id,
      type,
      name: item.title || item.name,
      description,
      poster: item.poster_path ? IMG + "w500" + item.poster_path : undefined,
      background: item.backdrop_path ? IMG + "w1280" + item.backdrop_path : undefined,
      genres: (item.genres || []).map((g) => g.name),
      releaseInfo: date.slice(0, 4),
      released: date ? new Date(date).toISOString() : undefined,
      imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
      runtime: runtime ? `${runtime} د` : undefined,
      cast: (credits.cast || []).slice(0, 8).map((c) => c.name),
      director
    };

    if (type === "movie") meta.behaviorHints = { defaultVideoId: imdb };
    else meta.videos = await getEpisodes(found.id, imdb);

    return { meta };
  } catch (e) {
    return { meta: null };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
