import {
  buildFallbackSeedCandidates,
  buildSummary,
  buildTargetedCandidates,
  exportWorkbook,
  fetchPage,
  formatPagesChecked,
  inspectPage,
  normalizeUrl,
  readDistricts,
} from "./shared.js";

const MAX_INTERNAL_PAGES = 10;
const MAX_SECONDARY_PAGES = 8;

export async function analyzeStage1({ inputPath, outputPath }) {
  const districts = await readDistricts(inputPath);
  const results = [];

  for (const district of districts) {
    results.push(await analyzeDistrictPresence(district));
  }

  const boarddocsRows = results.filter((row) => row.isBoarddocs);
  const nonBoarddocsRows = results.filter((row) => !row.isBoarddocs);

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

  return { summary: buildSummary(results) };
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

async function analyzeDistrictPresence(district) {
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
