const express = require("express");
const puppeteer = require("puppeteer-core");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const {
  parseExtraHosts,
  buildAllowedHosts,
  isAllowedImageUrl: isAllowedImageUrlIn,
  safeLogValue,
} = require("./lib/image-hosts");

// --- Config ---
const PORT = 3847;
const API_KEY = process.env.IMAGE_API_KEY;
const RENDER_TOKEN = process.env.RENDER_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const BUCKET = "social-images";
const MAX_CONCURRENT = 3;
const RENDER_TIMEOUT_MS = 20_000;

let SUPABASE_HOST = null;
if (SUPABASE_URL) {
  try {
    SUPABASE_HOST = new URL(SUPABASE_URL).hostname;
  } catch {
    console.error(`FATAL: SUPABASE_URL is not a valid URL: ${SUPABASE_URL}. Exiting.`);
    process.exit(1);
  }
}
const EXTRA_IMAGE_HOSTS = parseExtraHosts(process.env.EXTRA_IMAGE_HOSTS);
const ALLOWED_IMAGE_HOSTS = buildAllowedHosts({
  supabaseHost: SUPABASE_HOST,
  extraHosts: EXTRA_IMAGE_HOSTS,
});

if (!API_KEY) {
  console.error("FATAL: IMAGE_API_KEY is not set. Exiting.");
  process.exit(1);
}

let activeRenders = 0;

// --- Persistent browser ---
let sharedBrowser = null;
let browserLaunchPromise = null;
const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
];

async function getSharedBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (browserLaunchPromise) return browserLaunchPromise;
  browserLaunchPromise = puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: "new",
    args: CHROME_ARGS,
  }).then((browser) => {
    sharedBrowser = browser;
    browserLaunchPromise = null;
    browser.on("disconnected", () => { sharedBrowser = null; });
    console.log("Shared browser launched");
    return browser;
  }).catch((err) => {
    browserLaunchPromise = null;
    throw err;
  });
  return browserLaunchPromise;
}
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

function isAllowedImageUrl(url) {
  return isAllowedImageUrlIn(url, ALLOWED_IMAGE_HOSTS);
}

// --- Image generation ---
async function renderCard(data) {
  if (data.logo_url && !isAllowedImageUrl(data.logo_url)) {
    console.warn(`Dropped logo_url (host not allowed): ${safeLogValue(data.logo_url)}`);
    data = { ...data, logo_url: null };
  }
  if (data.cover_image_url && !isAllowedImageUrl(data.cover_image_url)) {
    console.warn(
      `Dropped cover_image_url (host not allowed): ${safeLogValue(data.cover_image_url)}`
    );
    data = { ...data, cover_image_url: null };
  }

  const browser = await getSharedBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
    await page.setContent(templateHtml, { waitUntil: "networkidle0", timeout: 8000 });
    await page.evaluate((d) => render(d), data);

    if (data.logo_url) {
      await page
        .waitForFunction(
          () => {
            const img = document.getElementById("logoImg");
            return img.complete || img.style.display === "none";
          },
          { timeout: 5000 }
        )
        .catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 500));

    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1080, height: 1080 },
    });

    return screenshot;
  } finally {
    await page.close().catch(() => {});
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
app.use(express.json({ limit: "5mb" }));

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
  let timeoutId;
  try {
    console.log(`Rendering card for: ${job_title} @ ${company_name}`);

    let timedOut = false;
    const renderPromise = renderCard(req.body).then((png) => {
      if (timedOut) return null;
      return uploadToStorage(png, job_id);
    });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(new Error("Render timed out"));
      }, RENDER_TIMEOUT_MS);
    });
    const imageUrl = await Promise.race([renderPromise, timeoutPromise]);
    clearTimeout(timeoutId);

    console.log(`Done: ${imageUrl}`);
    res.json({ image_url: imageUrl });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("Render failed:", err);
    res.status(500).json({ error: "Image generation failed" });
  } finally {
    activeRenders--;
  }
});

// --- PDF render endpoint ---
app.post("/render-pdf", async (req, res) => {
  const token = req.headers["x-render-token"];
  if (!RENDER_TOKEN || token !== RENDER_TOKEN) {
    return res.status(401).json({ error: "Invalid render token" });
  }

  const { html } = req.body;
  if (!html || typeof html !== "string") {
    return res.status(400).json({ error: "Missing required field: html (string)" });
  }

  let page;
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
    const pdfBytes = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      timeout: 30000,
    });
    const pdfBuffer = Buffer.from(pdfBytes);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (err) {
    console.error("PDF render failed:", err);
    res.status(500).json({ error: `PDF render failed: ${err.message}` });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// --- Start ---
async function main() {
  await ensureBucket();
  app.listen(PORT, () => {
    console.log(`Image generator running on port ${PORT}`);
    console.log(`Chromium: ${CHROMIUM_PATH}`);
    console.log(`Supabase: ${SUPABASE_URL ? "connected" : "local mode"}`);
    console.log(`Allowed image hosts: ${[...ALLOWED_IMAGE_HOSTS].join(", ")}`);
  });
}

main().catch(console.error);
