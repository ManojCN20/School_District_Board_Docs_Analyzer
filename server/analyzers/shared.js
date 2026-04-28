import fs from "node:fs/promises";
import path from "node:path";

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

export async function fetchPage(url, { timeoutMs = 10000 } = {}) {
  const candidates = [url];
  if (url.startsWith("https://")) {
    candidates.push(`http://${url.slice("https://".length)}`);
  }

  const { load } = await getCheerio();

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(candidate, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        continue;
      }

      const html = await response.text();
      const $ = load(html);
      const title = normalizeCell($("title").first().text());
      const pageText = normalizeCell($.root().text()).slice(0, 8000);

      return {
        url: response.url,
        html,
        title,
        text: pageText,
      };
    } catch {
      // keep trying fallback candidates
    } finally {
      clearTimeout(timeout);
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

    const resolved = new URL(href, pageUrl).toString();
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
  const pageHost = new URL(pageUrl).host.toLowerCase();
  const targeted = [];

  for (const candidate of rawCandidates) {
    if (candidate.isDirectBoarddocs) {
      targeted.push(candidate);
      continue;
    }

    const resolvedHost = new URL(candidate.url).host.toLowerCase();
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
