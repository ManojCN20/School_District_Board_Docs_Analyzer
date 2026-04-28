import fs from "node:fs";
import fsPromises from "node:fs/promises";
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
const analyzerLoaders = {
  stage1: async () => (await import("./analyzers/stage1.js")).analyzeStage1,
  stage2: async () => (await import("./analyzers/stage2.js")).analyzeStage2,
};
const requiredNodePackages = ["xlsx", "cheerio", "playwright"];

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
  });
});

app.post("/api/analyze/stage2", upload.single("file"), async (req, res) => {
  await handleAnalyzeRequest(req, res, {
    stage: "stage2",
    outputFileName: "district-boarddocs-verification-results.xlsx",
  });
});

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  await handleAnalyzeRequest(req, res, {
    stage: "stage2",
    outputFileName: "district-boarddocs-verification-results.xlsx",
  });
});

async function handleAnalyzeRequest(req, res, { stage, outputFileName }) {
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

  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    await fsPromises.writeFile(inputPath, req.file.buffer);

    const startedAt = Date.now();
    const analyze = await loadAnalyzer(stage);
    const analyzerResult = await analyze({ inputPath, outputPath });
    const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));

    res.json({
      stage,
      jobId,
      fileName: path.basename(outputPath),
      downloadUrl: `/downloads/${jobId}/${path.basename(outputPath)}`,
      summary: {
        ...analyzerResult.summary,
        elapsedSeconds,
      },
    });
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

async function loadAnalyzer(stage) {
  const loader = analyzerLoaders[stage];
  if (!loader) {
    throw new Error(`Unknown analyzer stage: ${stage}`);
  }
  return loader();
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
