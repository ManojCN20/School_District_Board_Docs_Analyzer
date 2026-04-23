import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import cors from "cors";
import express from "express";
import multer from "multer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(process.env.DATA_ROOT || path.join(workspaceRoot, "data"));
const uploadRoot = path.join(dataRoot, "uploads");
const outputRoot = path.join(dataRoot, "outputs");
const pythonScriptPath = path.join(workspaceRoot, "python-workdir", "analyze_districts.py");
const clientDistPath = path.join(workspaceRoot, "client", "dist");
const execFileAsync = promisify(execFile);
const requiredPythonModules = ["requests", "bs4", "openpyxl"];

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
let pythonBinary = process.env.PYTHON_BIN || "python3";
let pythonRuntimeError = null;

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
  res.status(pythonRuntimeError ? 503 : 200).json({
    ok: !pythonRuntimeError,
    pythonBinary,
    pythonReady: !pythonRuntimeError,
    pythonRuntimeError,
    dataRoot,
  });
});

app.post("/api/analyze", upload.single("file"), async (req, res) => {
  if (pythonRuntimeError) {
    return res.status(500).json({
      error: pythonRuntimeError,
    });
  }

  if (!req.file) {
    return res.status(400).json({
      error: "Upload an Excel or CSV file in the `file` field.",
    });
  }

  const extension = path.extname(req.file.originalname).toLowerCase();
  const supportedExtensions = new Set([".xlsx", ".xlsm", ".csv"]);

  if (!supportedExtensions.has(extension)) {
    return res.status(400).json({
      error: "Unsupported file type. Use .xlsx, .xlsm, or .csv.",
    });
  }

  const jobId = buildJobId();
  const uploadDir = path.join(uploadRoot, jobId);
  const outputDir = path.join(outputRoot, jobId);
  const inputPath = path.join(uploadDir, `district-input${extension}`);
  const outputPath = path.join(outputDir, "district-boarddocs-results.xlsx");

  try {
    await fsPromises.mkdir(uploadDir, { recursive: true });
    await fsPromises.mkdir(outputDir, { recursive: true });
    await fsPromises.writeFile(inputPath, req.file.buffer);

    const startedAt = Date.now();
    const analyzerResult = await runAnalyzer({ inputPath, outputPath });
    const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));

    return res.json({
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
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "The analysis process failed unexpectedly.",
    });
  }
});

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
    pythonBinary = await resolvePythonBinary();
    console.log(`Python analyzer runtime: ${pythonBinary}`);
  } catch (error) {
    pythonRuntimeError =
      error instanceof Error ? error.message : "Unable to validate the Python runtime.";
    console.error(pythonRuntimeError);
  }

  app.listen(port, host, () => {
    console.log(`Server listening on ${buildServerUrl()}`);
  });
}

function buildJobId() {
  const stamp = Date.now();
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${randomPart}`;
}

function runAnalyzer({ inputPath, outputPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonBinary,
      [pythonScriptPath, "--input", inputPath, "--output", outputPath],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Unable to start the Python analyzer with "${pythonBinary}": ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Python analyzer exited with code ${code}.${stderr ? ` ${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }

      try {
        const jsonLine = stdout
          .trim()
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);

        if (!jsonLine) {
          throw new Error("The analyzer returned no JSON payload.");
        }

        resolve(JSON.parse(jsonLine));
      } catch (error) {
        reject(
          new Error(
            `Analyzer completed but returned unreadable output.${stderr ? ` ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

async function resolvePythonBinary() {
  const candidates = [
    process.env.PYTHON_BIN,
    "python3",
    "python",
    "/opt/anaconda3/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];
  const importCommand = `import ${requiredPythonModules.join(", ")}; print("ok")`;
  const failures = [];

  for (const candidate of uniqueCandidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["-c", importCommand], {
        cwd: workspaceRoot,
        env: process.env,
        timeout: 8000,
      });

      if (stdout.includes("ok")) {
        return candidate;
      }
    } catch (error) {
      const stderr = error?.stderr?.toString?.().trim?.() || error.message;
      failures.push(`${candidate}: ${stderr}`);
    }
  }

  const installHint =
    "Install the Python packages with `python3 -m pip install -r requirements.txt`, or start the server with `PYTHON_BIN=/full/path/to/python3 npm run dev:server`.";
  const detail = failures.length > 0 ? ` Checked: ${failures.join(" | ")}` : "";
  throw new Error(
    `No usable Python runtime was found with ${requiredPythonModules.join(
      ", ",
    )} installed. ${installHint}${detail}`,
  );
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
