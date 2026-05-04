import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSummary,
  exportRemainingDistrictsWorkbook,
  readDistricts,
} from "./analyzers/shared.js";
import {
  buildDistrictFailureRow,
  writeStage1Workbook,
} from "./analyzers/stage1.js";
import { analyzeStage2 } from "./analyzers/stage2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const districtRunnerPath = path.join(__dirname, "district-runner.js");
const STAGE1_CHECKPOINT_INTERVAL = 25;
const STAGE1_CONCURRENCY = Math.max(1, Number.parseInt(process.env.STAGE1_CONCURRENCY ?? "6", 10) || 6);

let cancelRequested = false;

process.on("message", (message) => {
  if (message?.type === "stop") {
    cancelRequested = true;
  }
});

bootstrap().catch((error) => {
  const message =
    error instanceof Error ? error.message : "The analysis process failed unexpectedly.";
  process.send?.({
    type: "error",
    error: message,
  });
  process.exitCode = 1;
});

async function bootstrap() {
  const [, , stage, inputPath, outputPath, remainingPath] = process.argv;

  let result;
  if (stage === "stage1") {
    result = await analyzeStage1Isolated({
      inputPath,
      outputPath,
      remainingPath,
      shouldStop() {
        return cancelRequested;
      },
      onProgress(progress) {
        process.send?.({
          type: "progress",
          progress,
        });
      },
    });
  } else if (stage === "stage2") {
    result = await analyzeStage2({
      inputPath,
      outputPath,
      remainingPath,
      shouldStop() {
        return cancelRequested;
      },
      onProgress(progress) {
        process.send?.({
          type: "progress",
          progress,
        });
      },
    });
  } else {
    throw new Error(`Unknown analyzer stage: ${stage}`);
  }

  process.send?.({
    type: "result",
    result,
  });
}

async function analyzeStage1Isolated({
  inputPath,
  outputPath,
  remainingPath,
  shouldStop,
  onProgress,
}) {
  const districts = await readDistricts(inputPath);
  const results = new Array(districts.length);
  let cancelled = false;
  let completedCount = 0;
  let nextIndex = 0;
  const activeTasks = new Map();

  onProgress?.({
    totalDistricts: districts.length,
    completedDistricts: completedCount,
    remainingDistricts: districts.length,
    currentDistrictName: "",
  });

  while (completedCount < districts.length) {
    while (!shouldStop?.() && nextIndex < districts.length && activeTasks.size < STAGE1_CONCURRENCY) {
      const index = nextIndex;
      const district = districts[index];
      activeTasks.set(
        index,
        runDistrictWorker(district)
          .then((result) => ({ index, result }))
          .catch((error) => ({
            index,
            result: buildDistrictFailureRow(district, error),
          })),
      );
      nextIndex += 1;
    }

    if (shouldStop?.()) {
      cancelled = true;
    }

    onProgress?.({
      totalDistricts: districts.length,
      completedDistricts: completedCount,
      remainingDistricts: districts.length - completedCount,
      currentDistrictName: formatActiveDistrictNames(districts, [...activeTasks.keys()]),
    });

    if (activeTasks.size === 0) {
      break;
    }

    const finishedTask = await Promise.race(activeTasks.values());
    activeTasks.delete(finishedTask.index);
    results[finishedTask.index] = finishedTask.result;
    completedCount += 1;

    if (
      completedCount % STAGE1_CHECKPOINT_INTERVAL === 0 ||
      completedCount === districts.length ||
      (cancelled && activeTasks.size === 0)
    ) {
      await writeStage1Workbook(outputPath, results);
      if (remainingPath) {
        await exportRemainingDistrictsWorkbook(remainingPath, buildRemainingDistricts(districts, results));
      }
    }

    onProgress?.({
      totalDistricts: districts.length,
      completedDistricts: completedCount,
      remainingDistricts: districts.length - completedCount,
      currentDistrictName: formatActiveDistrictNames(districts, [...activeTasks.keys()]),
    });

    if (cancelled && activeTasks.size === 0) {
      break;
    }
  }

  await writeStage1Workbook(outputPath, results);
  if (remainingPath && !cancelled) {
    await exportRemainingDistrictsWorkbook(remainingPath, []);
  }

  return {
    summary: buildSummary(compactResults(results)),
    cancelled,
  };
}

async function runDistrictWorker(district) {
  return new Promise((resolve, reject) => {
    const child = fork(districtRunnerPath, [], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    child.on("message", (message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "result") {
        finish(resolve, message.result);
        child.kill();
        return;
      }

      if (message.type === "error") {
        finish(reject, new Error(message.error || "District worker failed unexpectedly."));
        child.kill();
      }
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      if (code === 0) {
        finish(reject, new Error("District worker exited without returning a result."));
        return;
      }

      finish(
        reject,
        new Error(
          `District worker exited unexpectedly${code != null ? ` with code ${code}` : ""}${signal ? ` and signal ${signal}` : ""}.`,
        ),
      );
    });

    child.send({
      type: "run",
      district,
    });
  });
}

function compactResults(results) {
  return results.filter(Boolean);
}

function buildRemainingDistricts(districts, results) {
  const remaining = [];
  for (let index = 0; index < districts.length; index += 1) {
    if (!results[index]) {
      remaining.push(districts[index]);
    }
  }
  return remaining;
}

function formatActiveDistrictNames(districts, activeIndexes) {
  if (activeIndexes.length === 0) {
    return "";
  }

  const names = activeIndexes
    .sort((left, right) => left - right)
    .slice(0, 3)
    .map((index) => districts[index]?.districtName)
    .filter(Boolean);

  if (activeIndexes.length <= 3) {
    return names.join(", ");
  }

  return `${names.join(", ")} (+${activeIndexes.length - 3} more)`;
}
