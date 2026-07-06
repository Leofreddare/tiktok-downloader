# tiktok-downloader Cloudflare Worker

Cloudflare Worker endpoint that accepts TikTok links like `vm.tiktok.com`, `vt.tiktok.com`, or `tiktok.com` and streams back an `.mp4` response.

No API key is required. No backend URL placeholder is required. The Worker uses Worker-native `fetch()` and a public TikWM lookup endpoint, then streams the returned video URL through Cloudflare.

## Endpoint

```txt
/mp4?url=https://vm.tiktok.com/xxxxx/
```

Also works:

```txt
/download.mp4?url=https://www.tiktok.com/@user/video/123
```

## Cloudflare Git build settings

Use these exact settings:

```txt
Build command: npm install
Deploy command: npx wrangler deploy
Root directory: /
```

Do not use static upload. Do not use `wrangler dev` in Cloudflare.

## Local commands

```bash
npm install
npm run dev
```

Deploy from your terminal:

```bash
npx wrangler login
npx wrangler deploy
```

## Test

```bash
curl -L "https://YOUR-WORKER.workers.dev/mp4?url=https://vm.tiktok.com/xxxxx/" -o tiktok.mp4
```

Use this only for videos you own or have permission to process.
