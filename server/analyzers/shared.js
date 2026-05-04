import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";

const DISTRICT_HEADER_HINTS = [
  "school district name",
  "district name",
  "district",
  "school district",
  "name",
];
const WEBSITE_HEADER_HINTS = ["website link", "website", "web site", "url", "link"];

export const BOARDDOCS_URL_PATTERN = /https?:\/\/[^\s"'<>)]*boarddocs[^\s"'<>)]*/i;
export const BOARDDOCS_TERMS = ["boarddocs"];
export const BOARD_LINK_TERMS = [
  "school board",
  "board of education",
  "board of school directors",
  "board of trustees",
  "board",
  "board meeting",
  "board meetings",
  "board agenda",
  "board agendas",
  "board minutes",
  "agenda",
  "agendas",
  "minutes",
  "governance",
  "trustees",
  "policies",
  "policy",
  "policy manual",
  "board policies",
  "documents",
];
export const ROOT_FALLBACK_PATHS = [
  "/departments",
  "/district-information",
  "/school-board",
  "/board",
  "/board-meetings",
  "/board-of-education",
  "/documents",
  "/site-map",
  "/sitemap",
];
export const YEAR_PATTERN = /\b20\d{2}\b/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..", "..");
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(workspaceRoot, "data"));
const crawlCacheRoot = path.join(dataRoot, "crawl-cache");
const crawlCacheTtlMs = parsePositiveInt(process.env.CRAWL_CACHE_MAX_AGE_HOURS, 168) * 60 * 60 * 1000;

let xlsxModulePromise = null;
let cheerioModulePromise = null;

async function getXlsx() {
  xlsxModulePromise ??= import("xlsx").then((module) => module.default ?? module);
  return xlsxModulePromise;
}

async function getCheerio() {
  cheerioModulePromise ??= import("cheerio");
  return cheerioModulePromise;
}

export async function readDistricts(inputPath) {
  const XLSX = await getXlsx();
  const workbook = XLSX.readFile(inputPath, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("The input workbook is empty.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });

  if (rows.length === 0) {
    throw new Error("The input workbook is empty.");
  }

  const headerIndex = findHeaderRow(rows);
  const headerRow = rows[headerIndex].map((value) => normalizeCell(value));
  const districtCol = findColumnIndex(headerRow, DISTRICT_HEADER_HINTS);
  const websiteCol = findColumnIndex(headerRow, WEBSITE_HEADER_HINTS);

  if (districtCol === null) {
    throw new Error(
      "Unable to find a district name column. Add a header such as 'School District Name' or 'District'.",
    );
  }

  const districts = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const districtName = normalizeCell(getCell(row, districtCol));
    const websiteLink = normalizeCell(getCell(row, websiteCol));
    if (!districtName) {
      continue;
    }

    districts.push({
      districtName,
      websiteLink,
    });
  }

  if (districts.length === 0) {
    throw new Error("No usable district rows were found below the header row.");
  }

  return districts;
}

export async function exportWorkbook(outputPath, sheets) {
  const XLSX = await getXlsx();
  const workbook = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const rows = [sheet.headers, ...sheet.rows];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!cols"] = sheet.headers.map((header, columnIndex) => {
      const maxLength = Math.max(
        header.length,
        ...sheet.rows.map((row) => String(row[columnIndex] ?? "").length),
      );
      return { wch: Math.min(Math.max(maxLength + 2, 18), 55) };
    });

    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const row = sheet.rows[rowIndex];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        const value = row[columnIndex];
        if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
          continue;
        }

        const cellAddress = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
        if (worksheet[cellAddress]) {
          worksheet[cellAddress].l = { Target: value };
        }
      }
    }

    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(workbook, outputPath);
}

export function buildSummary(results) {
  return {
    totalDistricts: results.length,
    boardDocsCount: results.filter((row) => row.isBoarddocs).length,
    nonBoardDocsCount: results.filter((row) => !row.isBoarddocs).length,
  };
}

export async function exportRemainingDistrictsWorkbook(outputPath, districts) {
  const rows = districts.map((district) => [
    district.districtName ?? "",
    normalizeUrl(district.websiteLink) || district.websiteLink || "",
  ]);

  await exportWorkbook(outputPath, [
    {
      name: "Remaining Districts",
      headers: ["School District Name", "Website Link"],
      rows,
    },
  ]);
}

export async function fetchPage(url, { timeoutMs = 10000 } = {}) {
  const candidates = [url];
  if (url.startsWith("https://")) {
    candidates.push(`http://${url.slice("https://".length)}`);
  }

  const { load } = await getCheerio();

  for (const candidate of candidates) {
    const cachedPage = await readFreshCachedPage(candidate);
    if (cachedPage) {
      return cachedPage;
    }

    try {
      const response = await requestHtml(candidate, timeoutMs);

      if (!response.ok) {
        continue;
      }

      const contentType = (response.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        continue;
      }

      const html = response.body;
      const $ = load(html);
      const title = normalizeCell($("title").first().text());
      const pageText = normalizeCell($.root().text()).slice(0, 8000);
      const page = {
        url: response.url,
        html,
        title,
        text: pageText,
      };

      await writeCachedPage(candidate, {
        sourceUrl: candidate,
        url: response.url,
        html,
        title,
        text: pageText,
        fetchedAt: new Date().toISOString(),
        headers: response.headers,
      });

      return page;
    } catch {
      const stalePage = await readStaleCachedPage(candidate);
      if (stalePage) {
        return stalePage;
      }
    }
  }

  return null;
}

export async function inspectPage(pageUrl, html, inheritedContext = "") {
  const directMatch = extractDirectMatch(pageUrl, html, inheritedContext);
  const candidates = [];

  if (directMatch) {
    return { directMatch, candidates };
  }

  const { load } = await getCheerio();
  const $ = load(html);

  $("a[href]").each((_, element) => {
    const href = normalizeCell($(element).attr("href") || "");
    if (!href) {
      return;
    }

    const parsed = safeUrlParse(href);
    if (parsed?.protocol && ["mailto:", "tel:", "javascript:"].includes(parsed.protocol)) {
      return;
    }

    const resolved = safeResolveUrl(href, pageUrl);
    if (!resolved) {
      return;
    }

    const anchorText = normalizeCell($(element).text());
    const anchorTitle = normalizeCell($(element).attr("title") || "");
    const anchorAria = normalizeCell($(element).attr("aria-label") || "");
    const searchableText = `${anchorText} ${anchorTitle} ${anchorAria} ${resolved}`.toLowerCase();

    if (BOARDDOCS_TERMS.some((term) => searchableText.includes(term))) {
      candidates.push({
        url: resolved,
        context: anchorText || anchorTitle || inheritedContext || pageUrl,
        priority: 1000,
        isDirectBoarddocs: true,
      });
      return;
    }

    candidates.push({
      url: resolved,
      context: anchorText || anchorTitle || inheritedContext || resolved,
      searchableText,
    });
  });

  return {
    directMatch: null,
    candidates: dedupeCandidates(candidates),
  };
}

export function extractDirectMatch(pageUrl, html, inheritedContext = "") {
  if (pageUrl.toLowerCase().includes("boarddocs")) {
    return {
      url: pageUrl,
      context: inheritedContext || pageUrl,
    };
  }

  const match = html.match(BOARDDOCS_URL_PATTERN);
  if (!match) {
    return null;
  }

  return {
    url: new URL(match[0], pageUrl).toString(),
    context: inheritedContext || pageUrl,
  };
}

export function buildTargetedCandidates(pageUrl, rawCandidates, { basePriority = 100 } = {}) {
  const parsedPageUrl = safeUrlParse(pageUrl);
  if (!parsedPageUrl) {
    return [];
  }

  const pageHost = parsedPageUrl.host.toLowerCase();
  const targeted = [];

  for (const candidate of rawCandidates) {
    if (candidate.isDirectBoarddocs) {
      targeted.push(candidate);
      continue;
    }

    const resolvedUrl = safeUrlParse(candidate.url);
    if (!resolvedUrl) {
      continue;
    }

    const resolvedHost = resolvedUrl.host.toLowerCase();
    if (resolvedHost && resolvedHost !== pageHost) {
      continue;
    }

    const searchableText = (candidate.searchableText || "").toLowerCase();
    if (!BOARD_LINK_TERMS.some((term) => searchableText.includes(term))) {
      continue;
    }

    let priority = basePriority;
    if (searchableText.includes("boarddocs")) {
      priority += 80;
    }
    if (searchableText.includes("polic")) {
      priority += 30;
    }
    if (
      searchableText.includes("agenda") ||
      searchableText.includes("meeting") ||
      searchableText.includes("minutes")
    ) {
      priority += 25;
    }

    targeted.push({
      url: candidate.url,
      context: candidate.context,
      priority,
    });
  }

  return dedupeCandidates(targeted);
}

export function buildFallbackSeedCandidates(homeUrl) {
  const parsed = new URL(homeUrl);
  const baseRoot = `${parsed.protocol}//${parsed.host}`;
  const seen = new Set();

  return ROOT_FALLBACK_PATHS.flatMap((fallbackPath) => {
    const url = `${baseRoot}${fallbackPath}`;
    if (seen.has(url)) {
      return [];
    }
    seen.add(url);
    return [
      {
        url,
        context: fallbackPath.replace(/^\//, "") || homeUrl,
        priority: 55,
      },
    ];
  });
}

export function dedupeCandidates(candidates) {
  const deduped = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate?.url || seen.has(candidate.url)) {
      continue;
    }
    seen.add(candidate.url);
    deduped.push(candidate);
  }

  return deduped;
}

export function normalizeUrl(value) {
  const cleaned = normalizeCell(value);
  if (!cleaned) {
    return "";
  }

  if (!/^https?:\/\//i.test(cleaned)) {
    return `https://${cleaned}`;
  }

  return cleaned;
}

export function normalizeCell(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim().replace(/\s+/g, " ");
}

export function formatPagesChecked(pagesChecked) {
  return [...new Set(pagesChecked)].join(" | ");
}

function getCell(row, index) {
  if (index == null || index >= row.length) {
    return "";
  }
  return row[index];
}

function findHeaderRow(rows) {
  let bestIndex = 0;
  let bestScore = -1;

  rows.slice(0, 10).forEach((row, index) => {
    const normalized = row.map((value) => normalizeCell(value).toLowerCase()).filter(Boolean).join(" ");
    const score = scoreHeaderCandidate(normalized);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function scoreHeaderCandidate(text) {
  let score = 0;
  if (DISTRICT_HEADER_HINTS.some((term) => text.includes(term))) {
    score += 2;
  }
  if (WEBSITE_HEADER_HINTS.some((term) => text.includes(term))) {
    score += 2;
  }
  return score;
}

function findColumnIndex(headers, hints) {
  let bestIndex = null;
  let bestScore = -1;

  headers.forEach((header, index) => {
    const normalized = header.toLowerCase();
    let score = 0;
    for (const hint of hints) {
      if (hint === normalized) {
        score += 3;
      } else if (normalized.includes(hint)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore > 0 ? bestIndex : null;
}

function safeUrlParse(value) {
  try {
    return new URL(value, "https://placeholder.local");
  } catch {
    return null;
  }
}

function safeResolveUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return "";
  }
}

async function requestHtml(url, timeoutMs, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error("Too many redirects");
  }

  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(absoluteTimeout);
      callback(value);
    };

    const absoluteTimeout = setTimeout(() => {
      request?.destroy(new Error("Request exceeded the time limit"));
    }, timeoutMs);

    request = client.request(
      parsedUrl,
      {
        method: "GET",
        rejectUnauthorized: false,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const headers = normalizeHeaders(response.headers);

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          const redirectedUrl = safeResolveUrl(headers.location, parsedUrl.toString());
          if (!redirectedUrl) {
            reject(new Error("Redirect location was invalid"));
            return;
          }
          resolve(requestHtml(redirectedUrl, timeoutMs, redirectCount + 1));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Response exceeded the size limit"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          try {
            const body = decodeResponseBody(Buffer.concat(chunks), headers["content-encoding"]);
            finish(resolve, {
              ok: statusCode >= 200 && statusCode < 300,
              status: statusCode,
              headers,
              url: parsedUrl.toString(),
              body,
            });
          } catch (error) {
            finish(reject, error);
          }
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Request timed out"));
    });
    request.on("error", (error) => finish(reject, error));
    request.end();
  });
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
    } else if (value != null) {
      normalized[key.toLowerCase()] = String(value);
    }
  }
  return normalized;
}

function decodeResponseBody(buffer, contentEncoding = "") {
  const normalizedEncoding = String(contentEncoding || "").toLowerCase();

  if (normalizedEncoding.includes("gzip")) {
    return gunzipSync(buffer).toString("utf8");
  }
  if (normalizedEncoding.includes("br")) {
    return brotliDecompressSync(buffer).toString("utf8");
  }
  if (normalizedEncoding.includes("deflate")) {
    return inflateSync(buffer).toString("utf8");
  }

  return buffer.toString("utf8");
}

async function readFreshCachedPage(url) {
  const cached = await readCachedPage(url);
  if (!cached) {
    return null;
  }

  const fetchedAt = Date.parse(cached.fetchedAt || "");
  if (!Number.isFinite(fetchedAt)) {
    return null;
  }

  if (Date.now() - fetchedAt > crawlCacheTtlMs) {
    return null;
  }

  return buildPageFromCache(cached);
}

async function readStaleCachedPage(url) {
  const cached = await readCachedPage(url);
  if (!cached) {
    return null;
  }
  return buildPageFromCache(cached);
}

async function readCachedPage(url) {
  try {
    const cachePath = buildCacheFilePath(url);
    const content = await fs.readFile(cachePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeCachedPage(url, payload) {
  try {
    const cachePath = buildCacheFilePath(url);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload), "utf8");
    await fs.rename(tempPath, cachePath);
  } catch {
    // cache writes are best-effort
  }
}

function buildPageFromCache(cached) {
  return {
    url: cached.url,
    html: cached.html,
    title: cached.title || "",
    text: cached.text || "",
  };
}

function buildCacheFilePath(url) {
  const hash = createHash("sha1").update(url).digest("hex");
  return path.join(crawlCacheRoot, hash.slice(0, 2), `${hash}.json`);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
