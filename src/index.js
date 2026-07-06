const CACHE_TTL_SECONDS_DEFAULT = 60 * 60 * 24 * 7;
const TIKWM_API_BASES = [
  "https://www.tikwm.com",
  "https://tikwm.com"
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Use GET /mp4?url=https://vm.tiktok.com/..." }, 405);
      }

      const reqUrl = new URL(request.url);
      const path = reqUrl.pathname.replace(/\/+$/, "") || "/";

      if (!["/", "/mp4", "/video", "/download", "/download.mp4"].includes(path)) {
        return json({ error: "Not found. Use /mp4?url=https://vm.tiktok.com/..." }, 404);
      }

      const input = reqUrl.searchParams.get("url") || reqUrl.searchParams.get("u");
      if (!input) {
        return json({
          error: "Missing TikTok URL",
          example: "/mp4?url=https://vm.tiktok.com/ZMxxxxxxx/"
        }, 400);
      }

      const tiktokUrl = normalizeTikTokUrl(input);
      if (!tiktokUrl) {
        return json({ error: "Only tiktok.com, vm.tiktok.com, and vt.tiktok.com links are allowed" }, 400);
      }

      const ttl = positiveInt(env?.CACHE_TTL_SECONDS, CACHE_TTL_SECONDS_DEFAULT);
      const hash = await sha256(tiktokUrl);
      const cacheKey = new Request(`https://tiktok-video-cache.invalid/${hash}`);

      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("X-Cache", "HIT");
        return cors(new Response(request.method === "HEAD" ? null : cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers
        }));
      }

      const info = await getTikwmInfo(tiktokUrl);
      const mp4Url = pickVideoUrl(info);

      if (!mp4Url) {
        return json({
          error: "No MP4 URL returned by TikWM",
          upstream: safePreview(info)
        }, 502);
      }

      const videoRes = await fetch(mp4Url, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          "Accept": "video/mp4,video/*,*/*",
          "Referer": "https://www.tiktok.com/"
        },
        cf: {
          cacheEverything: true,
          cacheTtl: ttl
        }
      });

      if (!videoRes.ok || !videoRes.body) {
        return json({
          error: "Failed to fetch MP4",
          status: videoRes.status,
          source: mp4Url
        }, 502);
      }

      const headers = new Headers();
      headers.set("Content-Type", "video/mp4");
      headers.set("Content-Disposition", `inline; filename="tiktok-${hash.slice(0, 12)}.mp4"`);
      headers.set("Cache-Control", `public, max-age=${ttl}`);
      headers.set("X-Cache", "MISS");
      headers.set("X-Video-Source", "tikwm");

      const len = videoRes.headers.get("Content-Length");
      if (len) headers.set("Content-Length", len);

      const acceptRanges = videoRes.headers.get("Accept-Ranges");
      if (acceptRanges) headers.set("Accept-Ranges", acceptRanges);

      const out = new Response(request.method === "HEAD" ? null : videoRes.body, {
        status: 200,
        headers
      });

      if (request.method === "GET") {
        ctx.waitUntil(caches.default.put(cacheKey, out.clone()));
      }

      return cors(out);
    } catch (err) {
      return json({
        error: "Worker failed",
        message: err?.message || String(err)
      }, 500);
    }
  }
};

async function getTikwmInfo(tiktokUrl) {
  let lastError = null;

  for (const base of TIKWM_API_BASES) {
    const getUrl = new URL("/api/", base);
    getUrl.searchParams.set("url", tiktokUrl);
    getUrl.searchParams.set("hd", "1");

    try {
      const getRes = await fetch(getUrl.toString(), {
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "User-Agent": UA,
          "Referer": "https://www.tiktok.com/"
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });

      const getData = await parseJsonOrText(getRes);
      if (getRes.ok && isUsefulTikwmResponse(getData)) return getData;
      lastError = getData;
    } catch (err) {
      lastError = err;
    }

    try {
      const body = new URLSearchParams();
      body.set("url", tiktokUrl);
      body.set("hd", "1");

      const postRes = await fetch(`${base}/api/`, {
        method: "POST",
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": UA,
          "Origin": base,
          "Referer": `${base}/`
        },
        body,
        cf: { cacheTtl: 300, cacheEverything: true }
      });

      const postData = await parseJsonOrText(postRes);
      if (postRes.ok && isUsefulTikwmResponse(postData)) return postData;
      lastError = postData;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`TikWM lookup failed: ${safePreview(lastError)}`);
}

function isUsefulTikwmResponse(value) {
  return Boolean(value && typeof value === "object" && value.data && typeof value.data === "object");
}

async function parseJsonOrText(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, text: text.slice(0, 500) };
  }
}

function pickVideoUrl(info) {
  const data = info?.data || info;
  if (!data || typeof data !== "object") return null;

  const candidates = [
    data.hdplay,
    data.play,
    data.wmplay,
    data.download_url,
    data.video_url,
    data.videoUrl,
    data.url
  ];

  for (const candidate of candidates) {
    const absolute = absoluteTikwmUrl(candidate);
    if (absolute) return absolute;
  }

  if (Array.isArray(data.images) && data.images.length > 0) {
    return null;
  }

  return null;
}

function absoluteTikwmUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();

  try {
    if (/^https?:\/\//i.test(v)) return new URL(v).toString();
    if (v.startsWith("//")) return new URL(`https:${v}`).toString();
    if (v.startsWith("/")) return new URL(v, "https://www.tikwm.com").toString();
  } catch {
    return null;
  }

  return null;
}

function normalizeTikTokUrl(input) {
  try {
    let raw = decodeURIComponent(input.trim());

    if (!/^https?:\/\//i.test(raw)) {
      raw = `https://${raw}`;
    }

    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    const allowed =
      host === "tiktok.com" ||
      host === "www.tiktok.com" ||
      host === "m.tiktok.com" ||
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

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  }));
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, X-Cache");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function safePreview(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
