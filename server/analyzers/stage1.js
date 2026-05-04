import {
  buildFallbackSeedCandidates,
  buildSummary,
  buildTargetedCandidates,
  exportWorkbook,
  exportRemainingDistrictsWorkbook,
  fetchPage,
  formatPagesChecked,
  inspectPage,
  normalizeUrl,
  readDistricts,
} from "./shared.js";

const MAX_INTERNAL_PAGES = 10;
const MAX_SECONDARY_PAGES = 8;
const CHECKPOINT_INTERVAL = 25;
const DISTRICT_TIMEOUT_MS = 120000;

export async function analyzeStage1({
  inputPath,
  outputPath,
  remainingPath,
  onProgress,
  shouldStop,
}) {
  const districts = await readDistricts(inputPath);
  const results = [];
  let cancelled = false;
  onProgress?.({
    totalDistricts: districts.length,
    completedDistricts: 0,
    remainingDistricts: districts.length,
    currentDistrictName: "",
  });

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
      results.push(await withDistrictTimeout(analyzeDistrictPresence(district), district.districtName));
    } catch (error) {
      results.push(buildDistrictFailureRow(district, error));
    }

    if ((index + 1) % CHECKPOINT_INTERVAL === 0 || index === districts.length - 1) {
      await writeStage1Workbook(outputPath, results);
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

  await writeStage1Workbook(outputPath, results);
  if (remainingPath && !cancelled) {
    await exportRemainingDistrictsWorkbook(remainingPath, []);
  }

  return { summary: buildSummary(results), cancelled };
}

export async function writeStage1Workbook(outputPath, results) {
  const completedRows = results.filter(Boolean);
  const boarddocsRows = completedRows.filter((row) => row.isBoarddocs);
  const nonBoarddocsRows = completedRows.filter((row) => !row.isBoarddocs);

  await exportWorkbook(outputPath, [
    {
      name: "BoardDocs Detected",
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
      name: "No BoardDocs Detected",
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

export async function discoverBoarddocsLinkForDistrict(district) {
  const websiteUrl = normalizeUrl(district.websiteLink);
  if (!websiteUrl) {
    return {
      websiteUrl: district.websiteLink,
      match: null,
      pagesChecked: [],
      reason: "Missing website link",
      confidence: "low",
    };
  }

  const homePage = await fetchPage(websiteUrl);
  if (!homePage) {
    return {
      websiteUrl,
      match: null,
      pagesChecked: [websiteUrl],
      reason: "Website could not be reached",
      confidence: "low",
    };
  }

  const pagesChecked = [homePage.url];
  const initialInspection = await inspectPage(homePage.url, homePage.html, homePage.url);
  if (initialInspection.directMatch) {
    return {
      websiteUrl: homePage.url,
      match: initialInspection.directMatch,
      pagesChecked,
      reason: "BoardDocs detected on the district website",
      confidence: "high",
    };
  }

  const queue = [
    ...buildTargetedCandidates(homePage.url, initialInspection.candidates, { basePriority: 120 }),
    ...buildFallbackSeedCandidates(homePage.url),
  ];
  const visited = new Set();
  const seededUrls = new Set(queue.map((candidate) => candidate.url));
  const secondarySeededUrls = new Set();
  let secondaryPagesVisited = 0;

  while (queue.length > 0 && visited.size < MAX_INTERNAL_PAGES) {
    queue.sort((left, right) => right.priority - left.priority);
    const current = queue.shift();
    if (!current || visited.has(current.url)) {
      continue;
    }

    visited.add(current.url);
    const currentPage = await fetchPage(current.url);
    if (!currentPage) {
      continue;
    }

    if (!pagesChecked.includes(currentPage.url)) {
      pagesChecked.push(currentPage.url);
    }

    const inspection = await inspectPage(
      currentPage.url,
      currentPage.html,
      current.context || currentPage.url,
    );
    if (inspection.directMatch) {
      return {
        websiteUrl: homePage.url,
        match: inspection.directMatch,
        pagesChecked,
        reason: "BoardDocs detected on the district website",
        confidence: "high",
      };
    }

    const secondaryCandidates = buildTargetedCandidates(currentPage.url, inspection.candidates, {
      basePriority: 90,
    });

    for (const candidate of secondaryCandidates) {
      if (secondaryPagesVisited >= MAX_SECONDARY_PAGES) {
        break;
      }
      if (
        visited.has(candidate.url) ||
        seededUrls.has(candidate.url) ||
        secondarySeededUrls.has(candidate.url)
      ) {
        continue;
      }

      secondarySeededUrls.add(candidate.url);
      secondaryPagesVisited += 1;
      const childPage = await fetchPage(candidate.url);
      if (!childPage) {
        continue;
      }

      if (!pagesChecked.includes(childPage.url)) {
        pagesChecked.push(childPage.url);
      }

      const childInspection = await inspectPage(
        childPage.url,
        childPage.html,
        candidate.context || childPage.url,
      );
      if (childInspection.directMatch) {
        return {
          websiteUrl: homePage.url,
          match: childInspection.directMatch,
          pagesChecked,
          reason: "BoardDocs detected on the district website",
          confidence: "high",
        };
      }
    }
  }

  return {
    websiteUrl: homePage.url,
    match: null,
    pagesChecked,
    reason: "No BoardDocs evidence found",
    confidence: "medium",
  };
}

export async function analyzeDistrictPresence(district) {
  const discovery = await discoverBoarddocsLinkForDistrict(district);
  return {
    districtName: district.districtName,
    websiteLink: discovery.websiteUrl,
    boarddocsLink: discovery.match?.url || "",
    isBoarddocs: Boolean(discovery.match),
    reason: discovery.reason,
    confidence: discovery.confidence,
    pagesChecked: formatPagesChecked(discovery.pagesChecked),
  };
}

export function buildDistrictFailureRow(district, error) {
  return {
    districtName: district.districtName,
    websiteLink: normalizeUrl(district.websiteLink) || district.websiteLink,
    boarddocsLink: "",
    isBoarddocs: false,
    reason: `District analysis failed: ${String(error?.message || error).slice(0, 180)}`,
    confidence: "low",
    pagesChecked: "",
  };
}

export function withDistrictTimeout(promise, districtName) {
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
