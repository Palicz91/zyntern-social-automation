const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// --- Config ---
const PORT = 3847;
const API_KEY = process.env.IMAGE_API_KEY || "zyntern-img-dev-key";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const BUCKET = "social-images";
const MAX_CONCURRENT = 3;

let activeRenders = 0;
const templateHtml = fs.readFileSync(
  path.join(__dirname, "template.html"),
  "utf8"
);

// --- Supabase ---
let supabase;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function ensureBucket() {
  if (!supabase) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (!data) {
    await supabase.storage.createBucket(BUCKET, { public: true });
    console.log(`Created bucket: ${BUCKET}`);
  }
}

// --- Image generation ---
async function renderCard(data) {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });

    // Load template
    await page.setContent(templateHtml, { waitUntil: "networkidle0", timeout: 8000 });

    // Inject data and render
    await page.evaluate((d) => render(d), data);

    // Wait for logo image to load (or fail) — max 5s
    if (data.logo_url) {
      await page
        .waitForFunction(
          () => {
            const img = document.getElementById("logoImg");
            return img.complete || img.style.display === "none";
          },
          { timeout: 5000 }
        )
        .catch(() => {
          // Logo didn't load — fallback already triggered by onerror
        });
    }

    // Brief settle for fonts/layout
    await new Promise((r) => setTimeout(r, 500));

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1080, height: 1080 },
    });

    return screenshot;
  } finally {
    await browser.close();
  }
}

async function uploadToStorage(buffer, jobId) {
  if (!supabase) {
    // No Supabase — save locally as fallback
    const dir = path.join(__dirname, "output");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const filename = `${jobId}_${Date.now()}.png`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);
    return `file://${filepath}`;
  }

  const filename = `${jobId}_${Date.now()}.png`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, buffer, {
      contentType: "image/png",
      upsert: true,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET).getPublicUrl(filename);

  return publicUrl;
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", active_renders: activeRenders });
});

// Generate endpoint
app.post("/generate", async (req, res) => {
  // Auth check
  const authKey = req.headers["x-api-key"];
  if (authKey !== API_KEY) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  // Concurrency limit
  if (activeRenders >= MAX_CONCURRENT) {
    return res.status(429).json({ error: "Too many concurrent renders" });
  }

  const { job_id, job_title, company_name } = req.body;
  if (!job_id || !job_title || !company_name) {
    return res
      .status(400)
      .json({ error: "Missing required fields: job_id, job_title, company_name" });
  }

  activeRenders++;
  try {
    console.log(`Rendering card for: ${job_title} @ ${company_name}`);

    const png = await renderCard(req.body);
    const imageUrl = await uploadToStorage(png, job_id);

    console.log(`Done: ${imageUrl}`);
    res.json({ image_url: imageUrl });
  } catch (err) {
    console.error("Render failed:", err);
    res.status(500).json({ error: "Image generation failed" });
  } finally {
    activeRenders--;
  }
});

// --- Start ---
async function main() {
  await ensureBucket();
  app.listen(PORT, () => {
    console.log(`Image generator running on port ${PORT}`);
    console.log(`Chromium: ${CHROMIUM_PATH}`);
    console.log(`Supabase: ${SUPABASE_URL ? "connected" : "local mode"}`);
  });
}

main().catch(console.error);
