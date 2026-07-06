# TikTok MP3 Cloudflare Worker

TikTok URL in, MP3 stream out.

This project ports the useful part of `BOTCAHX/tiktokdl-api` to Cloudflare Workers: call the TikTok resolver, get an audio URL, and stream it back as `audio/mpeg`.

Endpoints:

```text
/mp3?url=https://vm.tiktok.com/xxxxx/
/api?url=https://vm.tiktok.com/xxxxx/
/health
```

`/mp3` returns an `audio/mpeg` response.

`/api` returns JSON like this:

```json
{
  "ok": true,
  "audio": ["https://...mp3"],
  "video": ["https://...mp4"]
}
```

## Run locally

```bash
npm install
npm run dev
```

Then test:

```bash
curl -L "http://localhost:8787/mp3?url=https://vm.tiktok.com/xxxxx/" -o tiktok.mp3
```

## Deploy from terminal

```bash
npm install
npx wrangler login
npm run deploy
```

## Deploy through Cloudflare GitHub connection

Push this folder to a GitHub repo. In Cloudflare dashboard:

1. Workers & Pages
2. Create application
3. Worker
4. Import a repository
5. Pick this repo
6. Deploy command: `npm run deploy`
7. Build command: leave empty, or use `npm install`

Cloudflare will deploy again on every push.

## What it uses

- `btch-downloader` first, matching the BOTCAHX repo dependency.
- A Worker-native TikWM resolver fallback so more links work without you hosting another API.
- Cloudflare Cache API for fast repeated requests.
