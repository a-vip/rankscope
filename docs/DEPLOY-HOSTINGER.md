# Deploy RankScope to Hostinger

RankScope's backend is plain PHP, so it runs on **every Hostinger plan, including Single/Premium shared hosting**. You do not need a Node.js plan, a database or a build step on the server.

## 1. Build the upload folder (on your computer)

```bash
npm run bundle
```

This creates `dist/rankscope/`, containing `index.html`, `assets/`, `api/` and a hardened `.htaccess`.

## 2. Pick the address

Pick one of these:

| Option | Where to upload | URL |
|---|---|---|
| Sub-folder of your site | `public_html/rankscope/` | `https://aviperera.com/rankscope/` |
| Subdomain (recommended) | create `keywords.aviperera.com` in hPanel, then upload to its folder | `https://keywords.aviperera.com/` |

> [!NOTE]
> A sub-folder works alongside WordPress. WordPress's rewrite rules ignore real folders that exist on disk.

## 3. Upload

hPanel → **Files → File Manager**. Open the target folder and upload the **contents** of `dist/rankscope/` (not the folder itself). You can also use FTP. Make sure hidden files (`.htaccess`) are included.

## 4. Add your API keys (optional, but recommended)

In File Manager, inside `api/`:

1. Duplicate `config.sample.php` and rename the copy to `config.php`.
2. Edit `config.php` and fill in what you have:
   - `SERPER_API_KEY`: free at https://serper.dev. Unlocks measured difficulty, the live top 10 and People Also Ask.
   - `OPR_API_KEY`: free at https://www.domcop.com/openpagerank/. Real domain authority.
   - `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`: real Google Ads search volumes and CPC (paid per use).
   - `ACCESS_TOKEN`: **set this if the tool is public.** Paid sources then only work for browsers that enter the token in Settings → Access token.
   - `CORS_ORIGIN`: only needed if a different site (for example GitHub Pages) calls this API.

`config.php` is blocked from the web by `api/.htaccess`, and it is git-ignored, so keys never reach GitHub.

## 5. Check it works

1. Open `https://<your-address>/api/?s=config`. You should see `{"ok":true,"backend":"php",...}`, with `"keyed"` showing `true` for each key you added.
2. Open `https://<your-address>/`. The header badge should say **PHP backend**. Run an analysis.
3. Settings → **Data sources status** shows which sources answered from Hostinger's network.

## Updating

Pull the latest code, run `npm run bundle`, and re-upload everything **except** `api/config.php`. The cache folder `api/cache/` is created automatically and can be deleted at any time.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Badge says "Browser-only" | `api/` is missing, or PHP returned an error. Open `/api/?s=config` directly to see the response. |
| `config` shows a key as `false` | Typo in `config.php`, or the file is still named `config.sample.php`. |
| Paid sources say "Access token required" | Enter the same `ACCESS_TOKEN` in the app: Settings → Backend connection. |
| A free source shows "failing" | Some providers block datacenter IPs (Reddit and Amazon are the usual ones). Everything else keeps working, and scores use whatever answered. |
| "Rate limit reached" | Raise `RATE_LIMIT_PER_MIN` in `config.php`. A Deep analysis makes about 140 requests. |

