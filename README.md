## Automedia (MVP)

Website for small businesses to:
- take/upload a product photo
- generate a title + caption + hashtags via AI (vision + copy)
- edit the generated text
- post to social platforms via connected accounts

## Architecture (MVP)
- **Web**: React (mobile-first) + browser camera/file upload + simple editor UI
- **API**: Node.js (Express) with JWT auth
- **AI**: OpenAI vision-capable model for image + prompt → title/caption/hashtags
- **Posting**: provider adapters (Meta first; TikTok stub for MVP)
- **TikTok**: OAuth (Login Kit) + Content Posting API (video posting supported; photo posting requires public HTTPS URL ownership)
- **Storage**: local disk in MVP (swap to S3 later)

### Core flow
1. User logs in
2. Takes photo (camera) or selects from library
3. Uploads to API
4. API calls AI to generate `{title, caption, hashtags}`
5. User edits
6. User selects platform(s) → API posts via provider adapter

## Tech stack recommendation
- **Web**: Vite + React + TypeScript
- **Backend**: Node.js + TypeScript + Express + Zod + Multer
- **Auth**: JWT (MVP), upgrade to OAuth + refresh tokens
- **DB** (next step): Postgres + Prisma (optional for MVP; keep in-memory/local first)
- **Social**
  - Instagram/Facebook: Meta Graph API (requires app review + business/creator IG account)
  - TikTok: TikTok Content Posting API (requires approvals; start as stub)

## Prereqs
Install **Node.js LTS** (includes npm). After installing, reopen the terminal.

## Run (once Node is installed)
From repo root:

```bash
npm install
```

### Start API

```bash
npm run dev:api
```

### Start website

```bash
npm run dev:web
```

## Environment
Copy `.env.example` files:
- `apps/api/.env.example` → `apps/api/.env`

## TikTok setup without a domain (GitHub Pages)
TikTok requires public HTTPS URLs for **Terms of Service** and **Privacy Policy**. You can host them for free with GitHub Pages from this repo:
- `docs/terms.html`
- `docs/privacy.html`

After you push to GitHub:
- GitHub repo → **Settings** → **Pages**
- Source: **Deploy from a branch**
- Branch: `main` (or `master`)
- Folder: `/docs`

Then use the published links in TikTok’s portal:
- Terms: `https://<your-username>.github.io/<repo-name>/terms.html`
- Privacy: `https://<your-username>.github.io/<repo-name>/privacy.html`

