import btchDownloader from "btch-downloader";

const TIKWM_API = "https://www.tikwm.com/api/";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const META_CACHE_TTL_SECONDS = 60 * 60 * 24;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ttdl =
  btchDownloader?.ttdl ||
  btchDownloader?.default?.ttdl ||
  null;

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();

    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ ok: false, error: "Use GET /mp3?url=..." }, 405);
      }

      const reqUrl = new URL(request.url);

      if (reqUrl.pathname === "/health") {
        return json({ ok: true, service: "tiktok-mp3-worker" });
      }

      if (!["/", "/mp3", "/api"].includes(reqUrl.pathname)) {
        return json({ ok: false, error: "Use /mp3?url=https://vm.tiktok.com/..." }, 404);
      }

      const input = reqUrl.searchParams.get("url");
      if (!input) {
        return json({
          ok: false,
          error: "Missing TikTok URL",
          example: "/mp3?url=https://vm.tiktok.com/abc123/"
        }, 400);
      }

      const tiktokUrl = normalizeTikTokUrl(input);
      if (!tiktokUrl) {
        return json({ ok: false, error: "Only tiktok.com, vm.tiktok.com, vt.tiktok.com URLs are allowed" }, 400);
      }

      const id = await sha256(tiktokUrl);
      const metaCacheKey = new Request(`https://internal-cache.local/meta/${id}`);
      const mp3CacheKey = new Request(`https://internal-cache.local/mp3/${id}`);

      if (reqUrl.pathname === "/mp3" || reqUrl.pathname === "/") {
        const cachedMp3 = await caches.default.match(mp3CacheKey);
        if (cachedMp3) {
          const headers = new Headers(cachedMp3.headers);
          headers.set("X-Cache", "HIT");
          headers.set("X-Worker-Time", `${Date.now() - started}ms`);
          return withCors(new Response(request.method === "HEAD" ? null : cachedMp3.body, {
            status: 200,
            headers
          }));
        }
      }

      let meta = await getCachedJson(metaCacheKey);
      if (!meta) {
        meta = await getTikTokAudioMeta(tiktokUrl);
        ctx.waitUntil(cacheJson(metaCacheKey, meta, META_CACHE_TTL_SECONDS));
      }

      if (reqUrl.pathname === "/api") {
        return json({
          ok: true,
          source: meta.source,
          input: tiktokUrl,
          title: meta.title || null,
          author: meta.author || null,
          duration: meta.duration || null,
          audio: [meta.audioUrl],
          video: meta.videoUrl ? [meta.videoUrl] : [],
          cover: meta.cover || null,
          took: `${Date.now() - started}ms`
        });
      }

      const mp3Res = await fetch(meta.audioUrl, {
        method: "GET",
        headers: {
          "Accept": "audio/mpeg,audio/*,*/*",
          "User-Agent": UA,
          "Referer": "https://www.tiktok.com/"
        },
        cf: {
          cacheEverything: true,
          cacheTtl: CACHE_TTL_SECONDS
        }
      });

      if (!mp3Res.ok || !mp3Res.body) {
        return json({ ok: false, error: "Could not fetch MP3", status: mp3Res.status }, 502);
      }

      const headers = new Headers();
      headers.set("Content-Type", "audio/mpeg");
      headers.set("Content-Disposition", `inline; filename="tiktok-${id.slice(0, 12)}.mp3"`);
      headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, immutable`);
      headers.set("X-Cache", "MISS");
      headers.set("X-Worker-Time", `${Date.now() - started}ms`);

      const len = mp3Res.headers.get("Content-Length");
      if (len) headers.set("Content-Length", len);

      const out = new Response(request.method === "HEAD" ? null : mp3Res.body, {
        status: 200,
        headers
      });

      if (request.method === "GET") {
        ctx.waitUntil(caches.default.put(mp3CacheKey, out.clone()));
      }

      return withCors(out);
    } catch (err) {
      return json({
        ok: false,
        error: "Worker failed",
        message: err && err.message ? err.message : String(err)
      }, 500);
    }
  }
};

async function getTikTokAudioMeta(tiktokUrl) {
  if (typeof ttdl === "function") {
    try {
      const result = await ttdl(tiktokUrl);
      const audioUrl = pickFirstUrl(result?.audio || result?.mp3 || result?.music || result?.audio_url);
      const videoUrl = pickFirstUrl(result?.video || result?.mp4 || result?.play || result?.video_url);

      if (audioUrl) {
        return {
          source: "btch-downloader",
          audioUrl,
          videoUrl: videoUrl || null,
          title: result?.title || null,
          duration: result?.duration || null,
          cover: pickFirstUrl(result?.cover || result?.thumbnail) || null,
          author: result?.author || null
        };
      }
    } catch (err) {
      // Fall through to the Worker-native resolver below.
      // Some TikTok links fail on one resolver but work on the other.
    }
  }

  return resolveWithTikwm(tiktokUrl);
}

async function resolveWithTikwm(tiktokUrl) {
  const apiUrl = new URL(TIKWM_API);
  apiUrl.searchParams.set("url", tiktokUrl);
  apiUrl.searchParams.set("hd", "1");

  const res = await fetch(apiUrl.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": UA,
      "Referer": "https://www.tiktok.com/"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: META_CACHE_TTL_SECONDS
    }
  });

  if (!res.ok) {
    throw new Error(`TikTok resolver failed with HTTP ${res.status}`);
  }

  const body = await res.json();
  const data = body && body.data ? body.data : body;

  const audioUrl = absolutize(
    data.music ||
    data.music_info?.play ||
    data.music_info?.play_url ||
    data.audio ||
    data.audio_url
  );

  const videoUrl = absolutize(
    data.play ||
    data.wmplay ||
    data.hdplay ||
    data.video ||
    data.video_url
  );

  if (!audioUrl) {
    throw new Error("No audio URL returned for this TikTok");
  }

  return {
    source: "tikwm-fallback",
    audioUrl,
    videoUrl: videoUrl || null,
    title: data.title || null,
    duration: data.duration || null,
    cover: absolutize(data.cover || data.origin_cover || data.ai_dynamic_cover) || null,
    author: data.author
      ? {
          id: data.author.id || null,
          unique_id: data.author.unique_id || null,
          nickname: data.author.nickname || null
        }
      : null
  };
}

function pickFirstUrl(value) {
  if (Array.isArray(value)) return value.map(absolutize).find(Boolean) || null;
  return absolutize(value);
}

function absolutize(value) {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.tikwm.com${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function normalizeTikTokUrl(input) {
  try {
    let raw = String(input).trim();
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    const allowed =
      host === "tiktok.com" ||
      host === "www.tiktok.com" ||
      host === "vm.tiktok.com" ||
      host === "vt.tiktok.com" ||
      host.endsWith(".tiktok.com");

    if (!allowed) return null;

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function getCachedJson(cacheKey) {
  const res = await caches.default.match(cacheKey);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function cacheJson(cacheKey, data, ttl) {
  await caches.default.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttl}`
    }
  }));
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(data, status = 200) {
  return withCors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
