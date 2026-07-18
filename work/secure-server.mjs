import crypto from "node:crypto";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../outputs");
const localEnvPath = path.resolve(here, "../.env");
const dataRoot = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : here;
const dataPath = path.resolve(dataRoot, "site-data.json");

if (existsSync(localEnvPath)) {
  const localEnv = readFileSync(localEnvPath, "utf8");
  localEnv.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      return;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

const port = Number(process.env.PORT || 4173);

const adminUser = process.env.ADMIN_USER || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN || "";
const cloudflareZoneId = process.env.CLOUDFLARE_ZONE_ID || "";
const cloudflareZoneName = process.env.CLOUDFLARE_ZONE_NAME || "";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const liveCache = new Map();
const bonusPageCache = new Map();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const securityHeaders = {
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "content-security-policy": [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

function write(res, status, body, headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...headers });
  res.end(body);
}

function json(res, status, value) {
  write(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });
}

function missingAdminPasswordPage() {
  return `<!doctype html>
<html lang="zh-Hans">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Setup Required</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f17; color: #f8fafc; font-family: Arial, sans-serif; }
      main { width: min(560px, calc(100% - 32px)); border: 1px solid #283244; border-radius: 12px; padding: 28px; background: #121826; }
      h1 { margin: 0 0 12px; font-size: 24px; }
      p { color: #cbd5e1; line-height: 1.6; }
      code { color: #fbbf24; }
    </style>
  </head>
  <body>
    <main>
      <h1>后台还没有设置密码</h1>
      <p>请去 Railway 的 <strong>Variables</strong> 加入 <code>ADMIN_PASSWORD</code>，然后 Redeploy。</p>
      <p>Admin password is missing. Add <code>ADMIN_PASSWORD</code> in Railway Variables, then redeploy.</p>
    </main>
  </body>
</html>`;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function getSessionCookie() {
  const value = `admin:${Date.now()}`;
  return `${value}.${sign(value)}`;
}

function isValidSession(req) {
  const cookie = parseCookies(req).admin_session;
  if (!cookie || !cookie.includes(".")) {
    return false;
  }

  const index = cookie.lastIndexOf(".");
  const value = cookie.slice(0, index);
  const signature = cookie.slice(index + 1);
  const expected = sign(value);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function requiresAdmin(pathname) {
  if (pathname === "/admin.html") {
    return true;
  }

  if (
    pathname === "/api/site-data" ||
    pathname === "/api/live-transactions" ||
    pathname === "/api/bonus-page" ||
    pathname === "/api/bonus-image"
  ) {
    return false;
  }

  return pathname.startsWith("/api/");
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 8 * 1024 * 1024) {
      throw new Error("Request too large.");
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}

function cleanDomain(value) {
  const domain = String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("Domain 格式不正确。");
  }

  return domain;
}

function cleanTarget(value) {
  const target = String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  if (!target || target.length > 255) {
    throw new Error("Target Server 不能为空。");
  }

  return target;
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 0
    );
  }

  return false;
}

function cleanLiveUrl(value) {
  const liveUrl = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(liveUrl.protocol)) {
    throw new Error("Live URL must start with http:// or https://.");
  }

  if (liveUrl.username || liveUrl.password || isPrivateHost(liveUrl.hostname)) {
    throw new Error("Live URL is not allowed.");
  }

  return liveUrl.toString();
}

function cleanLiveRows(value) {
  const rows = Number(value || 3);
  if (!Number.isFinite(rows)) {
    return 3;
  }

  return Math.max(2, Math.min(10, Math.round(rows)));
}

async function readSiteData() {
  try {
    const raw = await readFile(dataPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cleanSiteData(body) {
  const source = body && typeof body === "object" ? body : {};
  return {
    siteSettings: source.siteSettings && typeof source.siteSettings === "object" ? source.siteSettings : {},
    offers: Array.isArray(source.offers) ? source.offers : [],
    socialLinks: Array.isArray(source.socialLinks) ? source.socialLinks : [],
    domains: Array.isArray(source.domains) ? source.domains : [],
    testIds: Array.isArray(source.testIds) ? source.testIds : [],
    updatedAt: new Date().toISOString(),
  };
}

function publicSiteData(data) {
  return {
    siteSettings: data.siteSettings || {},
    offers: Array.isArray(data.offers) ? data.offers : [],
    socialLinks: Array.isArray(data.socialLinks) ? data.socialLinks : [],
    updatedAt: data.updatedAt || "",
  };
}

async function writeSiteData(data) {
  await mkdir(path.dirname(dataPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function stripHtmlToLines(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:tr|p|li|div|section|article|table|tbody|thead|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function normalizeLiveAmount(value) {
  const amount = String(value || "").replace(/\s+/g, "");
  return amount.toUpperCase().startsWith("RM") ? amount.toUpperCase() : amount;
}

function parseLiveRowsFromText(text, limit) {
  const accountPattern = /(?:\+?60|0)\d*[*xX•●]{3,}\d{2,4}/g;
  const amountPattern = /RM\s*\d+(?:\.\d{1,2})?/gi;
  const lines = stripHtmlToLines(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const rows = [];

  for (const line of lines) {
    const accounts = line.match(accountPattern) || [];
    const amounts = line.match(amountPattern) || [];
    if (accounts.length < 2 || amounts.length < 2) {
      continue;
    }

    const secondAmountIndex = line.toLowerCase().lastIndexOf(amounts[1].toLowerCase()) + amounts[1].length;
    const game = line
      .slice(secondAmountIndex)
      .replace(/[|:,\-]+/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");

    rows.push({
      topUser: accounts[0],
      topAmount: normalizeLiveAmount(amounts[0]),
      withdrawUser: accounts[1],
      withdrawAmount: normalizeLiveAmount(amounts[1]),
      game,
    });

    if (rows.length >= limit) {
      break;
    }
  }

  return rows;
}

async function fetchLiveTransactions(url, limit) {
  const cacheKey = `${url}|${limit}`;
  const cached = liveCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 20000) {
    return cached.rows;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 LiveTransactionPreview/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Live page HTTP ${response.status}.`);
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > 600000) {
      throw new Error("Live page is too large.");
    }

    const body = await response.text();
    const rows = parseLiveRowsFromText(body.slice(0, 600000), limit);
    liveCache.set(cacheKey, { time: Date.now(), rows });
    return rows;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };

  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[key] || match;
  });
}

function getTagAttribute(tag, attribute) {
  const match = String(tag || "").match(new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtmlEntities(match?.[2] || match?.[3] || match?.[4] || "");
}

function getSrcsetUrl(value) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const last = items.at(-1) || "";
  return last.split(/\s+/)[0] || "";
}

function absolutePublicImageUrl(value, baseUrl) {
  const raw = decodeHtmlEntities(value).trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
    return "";
  }

  try {
    const parsed = new URL(raw, baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || isPrivateHost(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function scoreBonusImage(src, tagText) {
  const text = `${src} ${tagText}`.toLowerCase();
  let score = 0;
  if (/\.(?:png|jpe?g|webp|gif|svg)(?:$|[?#])/i.test(src)) {
    score += 2;
  }
  if (/(promo|promotion|bonus|banner|campaign|event|reward|free|credit|slot|slide|offer)/i.test(text)) {
    score += 4;
  }
  if (/(logo|icon|favicon|sprite|loader|avatar|facebook|telegram|whatsapp)/i.test(text)) {
    score -= 3;
  }
  return score;
}

function extractBonusSlides(html, baseUrl) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (src, tagText = "", alt = "") => {
    const imageUrl = absolutePublicImageUrl(src, baseUrl);
    if (!imageUrl || seen.has(imageUrl)) {
      return;
    }

    const score = scoreBonusImage(imageUrl, `${tagText} ${alt}`);
    if (score < 0) {
      return;
    }

    seen.add(imageUrl);
    candidates.push({
      src: imageUrl,
      alt: String(alt || "Bonus page").replace(/\s+/g, " ").trim().slice(0, 120),
      score,
      index: candidates.length,
    });
  };

  for (const match of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const alt = getTagAttribute(tag, "alt") || getTagAttribute(tag, "title");
    const width = Number.parseInt(getTagAttribute(tag, "width").replace(/\D/g, ""), 10);
    const height = Number.parseInt(getTagAttribute(tag, "height").replace(/\D/g, ""), 10);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width < 120 && height < 80) {
      continue;
    }

    ["data-src", "data-original", "data-lazy", "data-lazy-src", "src"].forEach((attribute) => {
      addCandidate(getTagAttribute(tag, attribute), tag, alt);
    });
    ["data-srcset", "srcset"].forEach((attribute) => {
      addCandidate(getSrcsetUrl(getTagAttribute(tag, attribute)), tag, alt);
    });
  }

  for (const match of String(html || "").matchAll(/<source\b[^>]*srcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    addCandidate(getSrcsetUrl(match[1]), match[0], "Bonus page");
  }

  for (const match of String(html || "").matchAll(/url\((["']?)([^"')]+)\1\)/gi)) {
    addCandidate(match[2], match[0], "Bonus page");
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .map(({ src, alt }) => ({ src, alt }));
}

async function fetchBonusPageSlides(url) {
  const cached = bonusPageCache.get(url);
  if (cached && Date.now() - cached.time < 60000) {
    return cached.slides;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7500);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 BonusPagePreview/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Bonus page HTTP ${response.status}.`);
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > 1000000) {
      throw new Error("Bonus page is too large.");
    }

    const body = await response.text();
    const slides = extractBonusSlides(body.slice(0, 1000000), url);
    bonusPageCache.set(url, { time: Date.now(), slides });
    return slides;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedResponseBuffer(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error("Image is too large.");
    }
    return Buffer.from(arrayBuffer);
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Image is too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

async function fetchBonusImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7500);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        referer: new URL(url).origin,
        "user-agent": "Mozilla/5.0 BonusImagePreview/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`Bonus image HTTP ${response.status}.`);
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > 2500000) {
      throw new Error("Image is too large.");
    }

    const contentType = String(response.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error("Bonus image is not an image.");
    }

    const body = await readLimitedResponseBuffer(response, 2500000);
    return {
      body,
      contentType,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function cloudflare(pathname, options = {}) {
  if (!cloudflareToken) {
    throw new Error("服务器没有设置 CLOUDFLARE_API_TOKEN。");
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${cloudflareToken}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const message = body.errors?.map((error) => error.message).join("; ") || `Cloudflare HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function zoneCandidates(domain) {
  const parts = domain.split(".");
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    candidates.push(parts.slice(i).join("."));
  }
  return candidates;
}

async function findZone(domain) {
  if (cloudflareZoneId) {
    return { id: cloudflareZoneId, name: cloudflareZoneName || domain };
  }

  for (const candidate of zoneCandidates(domain)) {
    const body = await cloudflare(`/zones?name=${encodeURIComponent(candidate)}&status=active`);
    const zone = body.result?.[0];
    if (zone?.id) {
      return { id: zone.id, name: zone.name };
    }
  }

  throw new Error("找不到 Cloudflare Zone，请确认 domain 已经加入 Cloudflare。");
}

async function upsertDnsRecord({ zoneId, name, type, content, proxied }) {
  const list = await cloudflare(
    `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`
  );
  const existing = list.result?.[0];
  const payload = {
    type,
    name,
    content,
    ttl: 1,
    proxied: type === "CNAME" ? Boolean(proxied) : false,
    comment: "Managed by landing admin secure backend",
  };

  if (existing?.id) {
    const updated = await cloudflare(`/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    return { action: "updated", record: updated.result };
  }

  const created = await cloudflare(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { action: "created", record: created.result };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/site-data" && req.method === "GET") {
    const data = await readSiteData();
    json(res, 200, {
      ok: true,
      hasServerData: Boolean(data.updatedAt),
      data: publicSiteData(data),
    });
    return;
  }

  if (pathname === "/api/site-data" && req.method === "PUT") {
    if (!adminPassword || !isValidSession(req)) {
      json(res, 401, { ok: false, error: "Admin login required." });
      return;
    }

    const body = await readJson(req);
    const data = cleanSiteData(body);
    await writeSiteData(data);
    json(res, 200, { ok: true, data: publicSiteData(data) });
    return;
  }

  if (pathname === "/api/admin-data" && req.method === "GET") {
    const data = await readSiteData();
    json(res, 200, {
      ok: true,
      hasServerData: Boolean(data.updatedAt),
      data,
    });
    return;
  }

  if (pathname === "/api/live-transactions" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const liveUrl = cleanLiveUrl(url.searchParams.get("url"));
    const rows = cleanLiveRows(url.searchParams.get("rows"));
    const liveRows = await fetchLiveTransactions(liveUrl, rows);
    json(res, 200, {
      ok: liveRows.length > 0,
      rows: liveRows,
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  if (pathname === "/api/bonus-page" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const bonusUrl = cleanLiveUrl(url.searchParams.get("url"));
    const slides = await fetchBonusPageSlides(bonusUrl);
    json(res, 200, {
      ok: slides.length > 0,
      slides,
      fetchedAt: new Date().toISOString(),
    });
    return;
  }

  if (pathname === "/api/bonus-image" && req.method === "GET") {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const imageUrl = cleanLiveUrl(url.searchParams.get("url"));
    const image = await fetchBonusImage(imageUrl);
    write(res, 200, image.body, {
      "content-type": image.contentType,
      "content-length": image.body.length,
      "cache-control": "public, max-age=300",
    });
    return;
  }

  if (pathname === "/api/security/status" && req.method === "GET") {
    json(res, 200, {
      ok: true,
      adminPasswordSet: Boolean(adminPassword),
      cloudflareTokenSet: Boolean(cloudflareToken),
      cloudflareZonePinned: Boolean(cloudflareZoneId),
    });
    return;
  }

  if (pathname === "/api/cloudflare/connect-domain" && req.method === "POST") {
    const body = await readJson(req);
    const domain = cleanDomain(body.domain);
    const targetServer = cleanTarget(body.targetServer);
    const cfProxy = String(body.cfProxy || "OFF").toUpperCase() === "ON";
    const recordType = String(body.recordType || "CNAME").toUpperCase();

    if (!["CNAME", "A"].includes(recordType)) {
      throw new Error("DNS type 只支持 CNAME 或 A。");
    }

    const zone = await findZone(domain);
    const result = await upsertDnsRecord({
      zoneId: zone.id,
      name: domain,
      type: recordType,
      content: targetServer,
      proxied: cfProxy,
    });

    json(res, 200, {
      ok: true,
      zone: zone.name,
      action: result.action,
      record: {
        id: result.record.id,
        name: result.record.name,
        type: result.record.type,
        content: result.record.content,
        proxied: result.record.proxied,
      },
    });
    return;
  }

  json(res, 404, { ok: false, error: "API not found." });
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="zh-Hans">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Login</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090b10; color: #f7f3e6; font-family: Arial, sans-serif; }
      form { width: min(92vw, 380px); padding: 24px; border: 1px solid #2b3442; border-radius: 8px; background: #131822; }
      h1 { margin: 0 0 16px; font-size: 24px; }
      input, button { width: 100%; min-height: 44px; box-sizing: border-box; border-radius: 8px; }
      input { margin-bottom: 12px; padding: 10px; border: 1px solid #2b3442; background: #0f141d; color: #fff; }
      button { border: 0; background: #f5c45a; color: #151515; font-weight: 900; cursor: pointer; }
      p { color: #e6534a; }
    </style>
  </head>
  <body>
    <form method="post" action="/admin-login">
      <h1>Admin Login</h1>
      ${error ? `<p>${error}</p>` : ""}
      <input name="user" placeholder="Username" autocomplete="username" />
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" />
      <button type="submit">Login</button>
    </form>
  </body>
</html>`;
}

async function handleLogin(req, res) {
  if (!adminPassword) {
    write(res, 503, missingAdminPasswordPage(), { "content-type": "text/html; charset=utf-8" });
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const user = params.get("user") || "";
  const password = params.get("password") || "";

  if (user === adminUser && password === adminPassword) {
    write(res, 302, "", {
      location: "/admin.html",
      "set-cookie": `admin_session=${encodeURIComponent(getSessionCookie())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`,
    });
    return;
  }

  write(res, 401, loginPage("账号或密码不正确。"), { "content-type": "text/html; charset=utf-8" });
}

async function serveFile(res, rawPath) {
  const relative = rawPath === "/" ? "index.html" : rawPath.slice(1);
  const filePath = path.resolve(root, relative);

  if (!filePath.startsWith(root)) {
    write(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    write(res, 200, body, { "content-type": types[path.extname(filePath)] || "application/octet-stream" });
  } catch {
    write(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const rawPath = decodeURIComponent(url.pathname);

    if (rawPath === "/admin-login" && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }

    if (rawPath === "/admin-login" && req.method === "GET") {
      write(res, 200, loginPage(), { "content-type": "text/html; charset=utf-8" });
      return;
    }

    if (requiresAdmin(rawPath)) {
      if (!adminPassword) {
        write(res, 503, missingAdminPasswordPage(), { "content-type": "text/html; charset=utf-8" });
        return;
      }

      if (!isValidSession(req)) {
        if (rawPath.startsWith("/api/")) {
          json(res, 401, { ok: false, error: "Admin login required." });
        } else {
          write(res, 302, "", { location: "/admin-login" });
        }
        return;
      }
    }

    if (rawPath.startsWith("/api/")) {
      await handleApi(req, res, rawPath);
      return;
    }

    await serveFile(res, rawPath);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message || "Server error." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`secure server running on http://127.0.0.1:${port}/`);
});
