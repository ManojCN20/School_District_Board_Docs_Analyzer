import { chromium } from "playwright";

import {
  BOARD_LINK_TERMS,
  YEAR_PATTERN,
  buildSummary,
  exportWorkbook,
  exportRemainingDistrictsWorkbook,
  formatPagesChecked,
  readDistricts,
} from "./shared.js";
import { discoverBoarddocsLinkForDistrict } from "./stage1.js";

const MEETING_TAB_TERMS = ["meeting", "meetings", "search meetings", "featured meetings"];
const CHECKPOINT_INTERVAL = 10;
const DISTRICT_TIMEOUT_MS = 180000;

export async function analyzeStage2({
  inputPath,
  outputPath,
  remainingPath,
  onProgress,
  shouldStop,
}) {
  const districts = await readDistricts(inputPath);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const results = [];
  let cancelled = false;
  onProgress?.({
    totalDistricts: districts.length,
    completedDistricts: 0,
    remainingDistricts: districts.length,
    currentDistrictName: "",
  });

  try {
    for (let index = 0; index < districts.length; index += 1) {
      if (shouldStop?.()) {
        cancelled = true;
        if (remainingPath) {
          await exportRemainingDistrictsWorkbook(remainingPath, districts.slice(index));
        }
        break;
      }

      const district = districts[index];
      onProgress?.({
        totalDistricts: districts.length,
        completedDistricts: index,
        remainingDistricts: districts.length - index,
        currentDistrictName: district.districtName,
      });

      try {
        results.push(await withDistrictTimeout(analyzeDistrictVerification(context, district), district.districtName));
      } catch (error) {
        results.push(buildDistrictFailureRow(district, error));
      }

      if ((index + 1) % CHECKPOINT_INTERVAL === 0 || index === districts.length - 1) {
        await writeStage2Workbook(outputPath, results);
        if (remainingPath) {
          await exportRemainingDistrictsWorkbook(remainingPath, districts.slice(index + 1));
        }
      }

      if (shouldStop?.()) {
        cancelled = true;
        if (remainingPath) {
          await exportRemainingDistrictsWorkbook(remainingPath, districts.slice(index + 1));
        }
        break;
      }

      onProgress?.({
        totalDistricts: districts.length,
        completedDistricts: index + 1,
        remainingDistricts: districts.length - (index + 1),
        currentDistrictName: index + 1 < districts.length ? districts[index + 1].districtName : "",
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }

  await writeStage2Workbook(outputPath, results);
  if (remainingPath && !cancelled) {
    await exportRemainingDistrictsWorkbook(remainingPath, []);
  }

  return { summary: buildSummary(results), cancelled };
}

async function writeStage2Workbook(outputPath, results) {
  const boarddocsRows = results.filter((row) => row.isBoarddocs);
  const nonBoarddocsRows = results.filter((row) => !row.isBoarddocs);

  await exportWorkbook(outputPath, [
    {
      name: "BoardDocs Districts",
      headers: [
        "School District Name",
        "Website Link",
        "BoardDocs Link",
        "Detection Reason",
        "Confidence",
        "Pages Checked",
      ],
      rows: boarddocsRows.map((row) => [
        row.districtName,
        row.websiteLink,
        row.boarddocsLink,
        row.reason,
        row.confidence,
        row.pagesChecked,
      ]),
    },
    {
      name: "Non BoardDocs Districts",
      headers: [
        "School District Name",
        "Website Link",
        "Detection Reason",
        "Confidence",
        "Pages Checked",
      ],
      rows: nonBoarddocsRows.map((row) => [
        row.districtName,
        row.websiteLink,
        row.reason,
        row.confidence,
        row.pagesChecked,
      ]),
    },
  ]);
}

async function analyzeDistrictVerification(context, district) {
  const discovery = await discoverBoarddocsLinkForDistrict(district);
  const pagesChecked = [...discovery.pagesChecked];

  if (!discovery.match) {
    return {
      districtName: district.districtName,
      websiteLink: discovery.websiteUrl,
      boarddocsLink: "",
      isBoarddocs: false,
      reason: discovery.reason,
      confidence: discovery.confidence,
      pagesChecked: formatPagesChecked(pagesChecked),
    };
  }

  const boarddocsUrl = discovery.match.url;
  const assessment = await verifyBoarddocsMeetings(context, boarddocsUrl, pagesChecked);

  return {
    districtName: district.districtName,
    websiteLink: discovery.websiteUrl,
    boarddocsLink: boarddocsUrl,
    isBoarddocs: assessment.isBoarddocs,
    reason: assessment.reason,
    confidence: assessment.confidence,
    pagesChecked: formatPagesChecked(pagesChecked),
  };
}

async function verifyBoarddocsMeetings(context, boarddocsUrl, pagesChecked) {
  const page = await context.newPage();

  try {
    await page.goto(boarddocsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(350);
    pagesChecked.push(page.url());

    const initialLabels = await extractVisibleLabelsFromPage(page);
    if (!labelsContainTerms(initialLabels, MEETING_TAB_TERMS)) {
      return {
        isBoarddocs: false,
        reason: "BoardDocs portal detected, but the following checks were missing: meeting tab, year",
        confidence: "low",
      };
    }

    const clickedMeetings = await clickVisibleLabel(page, MEETING_TAB_TERMS);
    if (clickedMeetings) {
      await page.waitForTimeout(350);
      pagesChecked.push(page.url());
    }

    const finalLabels = await extractVisibleLabelsFromPage(page);
    const finalText = [...finalLabels].join(" ");
    const hasYear = YEAR_PATTERN.test(finalText);

    if (hasYear) {
      return {
        isBoarddocs: true,
        reason: "BoardDocs meetings page showed a visible year after opening Meetings",
        confidence: "high",
      };
    }

    return {
      isBoarddocs: false,
      reason: "BoardDocs meetings page was opened, but the following checks were missing: year",
      confidence: "low",
    };
  } catch (error) {
    return {
      isBoarddocs: false,
      reason: `BoardDocs link found on the district site, but the BoardDocs page could not be loaded: ${String(error.message || error).slice(0, 180)}`,
      confidence: "low",
    };
  } finally {
    await page.close();
  }
}

async function extractVisibleLabelsFromPage(page) {
  const texts = await page.evaluate((boardTerms) => {
    const yearPattern = /\b20\d{2}\b/;
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const labels = [];
    const nodes = document.querySelectorAll("a, button, input, label, option, li, div[role='tab'], span");
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }

      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) {
        continue;
      }

      if (boardTerms.some((term) => text.includes(term)) || yearPattern.test(text)) {
        labels.push(text);
      }
    }

    return labels;
  }, [...BOARD_LINK_TERMS, ...MEETING_TAB_TERMS]);

  return new Set(texts.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

async function clickVisibleLabel(page, terms) {
  return page.evaluate((needleTerms) => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const candidates = document.querySelectorAll("a, button, li, div[role='tab'], span");
    for (const node of candidates) {
      if (!isVisible(node)) {
        continue;
      }

      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) {
        continue;
      }

      if (needleTerms.some((term) => text === term || text.includes(term))) {
        node.click();
        return true;
      }
    }

    return false;
  }, terms);
}

function labelsContainTerms(labels, terms) {
  for (const label of labels) {
    for (const term of terms) {
      if (label === term || label.includes(term)) {
        return true;
      }
    }
  }
  return false;
}

function buildDistrictFailureRow(district, error) {
  return {
    districtName: district.districtName,
    websiteLink: district.websiteLink,
    boarddocsLink: "",
    isBoarddocs: false,
    reason: `District analysis failed: ${String(error?.message || error).slice(0, 180)}`,
    confidence: "low",
    pagesChecked: "",
  };
}

function withDistrictTimeout(promise, districtName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `District timed out after ${Math.round(DISTRICT_TIMEOUT_MS / 1000)} seconds: ${districtName}`,
        ),
      );
    }, DISTRICT_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
