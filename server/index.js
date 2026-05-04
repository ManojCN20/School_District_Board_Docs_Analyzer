import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { fork } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";
import multer from "multer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(workspaceRoot, "data"));
const uploadRoot = path.join(dataRoot, "uploads");
const outputRoot = path.join(dataRoot, "outputs");
const clientDistPath = path.join(workspaceRoot, "client", "dist");
const jobRunnerPath = path.join(__dirname, "job-runner.js");
const requiredNodePackages = ["xlsx", "cheerio", "playwright"];
const jobs = new Map();

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
let analyzerRuntimeError = null;
let httpServer = null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
});

app.use(
  cors({
    origin: buildCorsOriginSetting(process.env.CORS_ORIGIN),
  }),
);
app.use(express.json());
app.use("/downloads", express.static(outputRoot));

app.get("/api/health", (_req, res) => {
  res.status(analyzerRuntimeError ? 503 : 200).json({
    ok: !analyzerRuntimeError,
    analyzer: "node",
    analyzerReady: !analyzerRuntimeError,
    analyzerRuntimeError,
    dataRoot,
  });
});

app.post("/api/analyze/stage1", upload.single("file"), async (req, res) => {
  await handleAnalyzeRequest(req, res, {
    stage: "stage1",
    outputFileName: "district-boarddocs-presence-results.xlsx",
    remainingFileName: "remaining-stage1-districts.xlsx",
  });
});

app.post("/api/analyze/stage2", upload.single("file"), async (req, res) => {
  await handleAnalyzeRequest(req, res, {
    stage: "stage2",
    outputFileName: "district-boarddocs-verification-results.xlsx",
    remainingFileName: "remaining-stage2-districts.xlsx",
  });
});

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  await handleAnalyzeRequest(req, res, {
    stage: "stage2",
    outputFileName: "district-boarddocs-verification-results.xlsx",
    remainingFileName: "remaining-stage2-districts.xlsx",
  });
});

app.get("/api/jobs/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({
      error: "Job not found.",
    });
    return;
  }

  res.json(await buildJobPayload(job));
});

app.post("/api/jobs/:jobId/stop", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({
      error: "Job not found.",
    });
    return;
  }

  if (job.status === "running" || job.status === "queued" || job.status === "stopping") {
    job.cancelRequested = true;
    if (job.status === "running" || job.status === "queued") {
      job.status = "stopping";
    }
    if (job.child?.connected) {
      job.child.send({ type: "stop" });
    }
  }

  res.json(await buildJobPayload(job));
});

async function handleAnalyzeRequest(req, res, { stage, outputFileName, remainingFileName }) {
  if (analyzerRuntimeError) {
    res.status(500).json({
      error: analyzerRuntimeError,
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({
      error: "Upload an Excel or CSV file in the `file` field.",
    });
    return;
  }

  const extension = path.extname(req.file.originalname).toLowerCase();
  const supportedExtensions = new Set([".xlsx", ".xlsm", ".csv"]);
  if (!supportedExtensions.has(extension)) {
    res.status(400).json({
      error: "Unsupported file type. Use .xlsx, .xlsm, or .csv.",
    });
    return;
  }

  const jobId = buildJobId();
  const uploadDir = path.join(uploadRoot, jobId);
  const outputDir = path.join(outputRoot, jobId);
  const inputPath = path.join(uploadDir, `district-input${extension}`);
  const outputPath = path.join(outputDir, outputFileName);
  const remainingPath = path.join(outputDir, remainingFileName);

  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    await fsPromises.writeFile(inputPath, req.file.buffer);

    const job = {
      jobId,
      stage,
      status: "queued",
      inputPath,
      outputPath,
      remainingPath,
      outputFileName: path.basename(outputPath),
      remainingFileName: path.basename(remainingPath),
      currentDistrictName: "",
      totalDistricts: 0,
      completedDistricts: 0,
      remainingDistricts: 0,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: "",
      cancelRequested: false,
      child: null,
    };

    jobs.set(jobId, job);
    void runAnalysisJob(job);

    res.status(202).json(await buildJobPayload(job));
  } catch (error) {
    console.error("Analysis failed:", error);

    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "The analysis process failed unexpectedly.",
    });
  }
}

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get(/^(?!\/api|\/downloads).*/, (_req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

bootstrap();

async function bootstrap() {
  await fsPromises.mkdir(uploadRoot, { recursive: true });
  await fsPromises.mkdir(outputRoot, { recursive: true });

  try {
    await validateAnalyzerRuntime();
    console.log("Node analyzer runtime ready");
  } catch (error) {
    analyzerRuntimeError =
      error instanceof Error ? error.message : "Unable to validate the Node analyzer runtime.";
    console.error(analyzerRuntimeError);
  }

  httpServer = app.listen(port, host, () => {
    console.log(`Server listening on ${buildServerUrl()}`);
  });

  httpServer.on("error", (error) => {
    console.error(`Server failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}

function buildJobId() {
  const stamp = Date.now();
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${randomPart}`;
}

async function validateAnalyzerRuntime() {
  const require = createRequire(import.meta.url);
  const missingPackages = [];

  for (const packageName of requiredNodePackages) {
    try {
      require.resolve(packageName);
    } catch {
      missingPackages.push(packageName);
    }
  }

  if (missingPackages.length > 0) {
    throw new Error(
      `Missing Node analyzer packages: ${missingPackages.join(", ")}. Run \`npm install\`, then \`npm run setup:browser\`.`,
    );
  }
}

async function runAnalysisJob(job) {
  job.status = "running";
  job.startedAt = Date.now();

  const child = fork(jobRunnerPath, [job.stage, job.inputPath, job.outputPath, job.remainingPath], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  job.child = child;

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[job ${job.jobId}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[job ${job.jobId}] ${chunk}`);
  });

  child.on("message", (message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "progress" && message.progress) {
      const progress = message.progress;
      if (typeof progress.totalDistricts === "number") {
        job.totalDistricts = progress.totalDistricts;
      }
      if (typeof progress.completedDistricts === "number") {
        job.completedDistricts = progress.completedDistricts;
      }
      if (typeof progress.remainingDistricts === "number") {
        job.remainingDistricts = progress.remainingDistricts;
      }
      if (typeof progress.currentDistrictName === "string") {
        job.currentDistrictName = progress.currentDistrictName;
      }
      return;
    }

    if (message.type === "result" && message.result) {
      job.summary = message.result.summary ?? null;
      job.status = message.result.cancelled ? "cancelled" : "completed";
      job.finishedAt = Date.now();
      job.currentDistrictName = "";
      job.cancelRequested = false;
      return;
    }

    if (message.type === "error") {
      job.error = message.error || "The analysis process failed unexpectedly.";
    }
  });

  child.on("exit", (code, signal) => {
    job.child = null;

    if (job.finishedAt) {
      return;
    }

    job.finishedAt = Date.now();
    job.currentDistrictName = "";
    job.cancelRequested = false;

    if (code === 0) {
      job.status = "completed";
      if (!job.summary) {
        job.error = "The analysis worker exited without returning a summary.";
      }
      return;
    }

    job.status = "failed";
    job.error =
      job.error ||
      `The analysis worker exited unexpectedly${code != null ? ` with code ${code}` : ""}${signal ? ` and signal ${signal}` : ""}.`;
  });

  if (job.cancelRequested) {
    child.send({ type: "stop" });
  }
}

function buildCorsOriginSetting(rawValue) {
  if (!rawValue || rawValue.trim() === "*" || rawValue.trim() === "") {
    return true;
  }

  const allowedOrigins = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return function corsOrigin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Request origin is not allowed by CORS."));
  };
}

function buildServerUrl() {
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }

  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${displayHost}:${port}`;
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildJobPayload(job) {
  const elapsedMs = Math.max(
    0,
    (job.finishedAt ?? (job.startedAt ? Date.now() : job.createdAt)) - (job.startedAt ?? job.createdAt),
  );
  const elapsedSeconds = Number((elapsedMs / 1000).toFixed(1));
  const hasOutput = await fileExists(job.outputPath);
  const hasRemaining = await fileExists(job.remainingPath);
  const etaSeconds =
    job.status === "running" && job.completedDistricts > 0 && job.remainingDistricts > 0
      ? Math.ceil((elapsedMs / job.completedDistricts / 1000) * job.remainingDistricts)
      : 0;

  return {
    jobId: job.jobId,
    stage: job.stage,
    status: job.status,
    cancelRequested: job.cancelRequested,
    totalDistricts: job.totalDistricts,
    completedDistricts: job.completedDistricts,
    remainingDistricts: job.remainingDistricts,
    currentDistrictName: job.currentDistrictName,
    elapsedSeconds,
    estimatedSecondsRemaining: etaSeconds,
    fileName: hasOutput ? job.outputFileName : "",
    downloadUrl: hasOutput ? `/downloads/${job.jobId}/${job.outputFileName}` : "",
    remainingFileName: hasRemaining ? job.remainingFileName : "",
    remainingDownloadUrl: hasRemaining ? `/downloads/${job.jobId}/${job.remainingFileName}` : "",
    summary:
      job.summary && job.finishedAt
        ? {
            ...job.summary,
            elapsedSeconds,
          }
        : null,
    error: job.error,
  };
}
