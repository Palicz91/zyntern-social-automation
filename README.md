# Zyntern Social Media Automation

Automated social media posting pipeline for Zyntern job listings. Receives job data via API, generates branded visual cards with AI-written copy, and publishes to LinkedIn, Facebook, and Instagram — with a human approval step in between.

## Architecture

```
                                 ┌─────────────────┐
                                 │  Zyntern Portal  │
                                 └────────┬────────┘
                                          │ POST /publish-job
                                          ▼
                              ┌───────────────────────┐
                              │  Supabase Edge Function │
                              │  (publish-job)          │
                              └───────────┬─────────────┘
                                          │ insert
                                          ▼
                              ┌───────────────────────┐
                              │  Supabase PostgreSQL    │
                              │  social_posts table     │
                              └───────────┬─────────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                   ┌────────────┐  ┌────────────┐  ┌────────────┐
                   │ AI Copy    │  │ Image Gen  │  │ Dashboard  │
                   │ (Claude)   │  │ (Puppeteer)│  │ (React)    │
                   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
                         │               │               │
                         └───────┬───────┘               │
                                 ▼                       │
                         ┌──────────────┐                │
                         │ Ready post   │◄───────────────┘
                         │ (pending)    │   approve / edit
                         └──────┬───────┘
                                │ approved
                                ▼
                    ┌──────────────────────┐
                    │  Social Media APIs    │
                    │  LinkedIn / FB / IG   │
                    └──────────────────────┘
```

## Setup

1. Clone this repo
2. Copy `.env.example` to `.env` and fill in credentials
3. Set up Supabase project and run migrations
4. Deploy the Edge Function to Supabase
5. Deploy the dashboard to Netlify
6. Start the image generator service

Detailed setup instructions will be added per component.

## Environment variables

See `.env.example` for the full list. Key groups:

- **Supabase** — database and edge function hosting
- **Anthropic** — Claude API for generating post copy
- **LinkedIn** — OAuth access token for company page posting
- **Facebook / Instagram** — Page access token and account IDs
- **Image service** — URL of the Puppeteer card generator
- **API auth** — bearer token for the publish-job endpoint
