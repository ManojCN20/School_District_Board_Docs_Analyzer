import { useEffect, useState } from "react";

const initialResult = null;
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const stages = {
  stage1: {
    id: "stage1",
    eyebrow: "Stage 1",
    title: "Find Any BoardDocs Usage",
    subtitle:
      "Fast scan to find districts that use BoardDocs in any form, including policies or meeting portals.",
    endpoint: "/api/analyze/stage1",
    outputDescription:
      "One sheet for districts where any BoardDocs usage was detected, and another for districts where no BoardDocs evidence was found.",
    helperCopy:
      "Use this first for large uploads. It is tuned to quickly separate districts with any BoardDocs presence from districts with none.",
    positiveLabel: "BoardDocs detected",
    negativeLabel: "No BoardDocs detected",
    buttonLabel: "Run Stage 1 scan",
    runningLabel: "Scanning districts...",
  },
  stage2: {
    id: "stage2",
    eyebrow: "Stage 2",
    title: "Verify Meetings Workflow",
    subtitle:
      "Focused verification for districts already suspected of using BoardDocs. The crawler opens BoardDocs, looks for Meetings, and then checks for a visible year.",
    endpoint: "/api/analyze/stage2",
    outputDescription:
      "One sheet for districts that passed the stricter BoardDocs meetings check, and another for districts that did not.",
    helperCopy:
      "Run this on the Stage 1 positives when you need the stricter meeting-based BoardDocs check.",
    positiveLabel: "Verified BoardDocs",
    negativeLabel: "Not verified",
    buttonLabel: "Run Stage 2 verification",
    runningLabel: "Verifying BoardDocs...",
  },
};

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

function buildApiUrl(path) {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}

function buildDownloadUrl(downloadUrl) {
  if (!downloadUrl) {
    return "";
  }

  if (/^https?:\/\//i.test(downloadUrl)) {
    return downloadUrl;
  }

  return apiBaseUrl ? `${apiBaseUrl}${downloadUrl}` : downloadUrl;
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text();

  if (!contentType.includes("application/json")) {
    const responseUrl = response.url || "the requested endpoint";
    throw new Error(
      `Expected JSON from ${responseUrl}, but received ${contentType || "a non-JSON response"}. Open the app from the active Vite URL and make sure the API is running.`,
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error("The server returned invalid JSON.");
  }
}

export default function App() {
  const [stageId, setStageId] = useState("stage1");
  const [file, setFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState(null);
  const [partialResult, setPartialResult] = useState(null);
  const [result, setResult] = useState(initialResult);
  const [apiStatus, setApiStatus] = useState("Checking API...");
  const stage = stages[stageId];

  useEffect(() => {
    if (!result?.downloadUrl) {
      return;
    }

    const downloadHref = buildDownloadUrl(result.downloadUrl);
    if (!downloadHref) {
      return;
    }

    const link = document.createElement("a");
    link.href = downloadHref;
    link.download = result.fileName || "";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [result?.downloadUrl, result?.fileName]);

  useEffect(() => {
    if (!job?.jobId || ["completed", "failed", "cancelled"].includes(job.status)) {
      return undefined;
    }

    let isCancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(buildApiUrl(`/api/jobs/${job.jobId}`));
        const payload = await readJsonResponse(response);

        if (isCancelled) {
          return;
        }

        setJob(payload);

        if (payload.status === "completed") {
          setResult(payload);
          setIsSubmitting(false);
        } else if (payload.status === "cancelled") {
          setResult(payload);
          setPartialResult(payload);
          setIsSubmitting(false);
        } else if (payload.status === "failed") {
          setError(payload.error || "The analysis request failed.");
          if (payload.downloadUrl) {
            setPartialResult(payload);
          }
          setIsSubmitting(false);
        }
      } catch {
        if (!isCancelled) {
          setError("Lost contact with the analysis job.");
          setIsSubmitting(false);
        }
      }
    }, 1500);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [job?.jobId, job?.status]);

  useEffect(() => {
    let isActive = true;

    async function checkApiHealth() {
      try {
        const response = await fetch(buildApiUrl("/api/health"));
        const payload = await readJsonResponse(response);

        if (!isActive) {
          return;
        }

        if (!response.ok || !payload.ok) {
          setApiStatus("API unavailable");
          return;
        }

        setApiStatus(`API ready (${payload.analyzer || "node"})`);
      } catch {
        if (isActive) {
          setApiStatus("API unreachable");
        }
      }
    }

    checkApiHealth();

    return () => {
      isActive = false;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!file) {
      setError("Choose an input workbook before starting the analysis.");
      return;
    }

    setError("");
    setPartialResult(null);
    setResult(null);
    setJob(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(buildApiUrl(stage.endpoint), {
        method: "POST",
        body: formData,
      });

      const payload = await readJsonResponse(response);

      if (!response.ok) {
        if (payload.partialAvailable) {
          setPartialResult(payload);
        }
        throw new Error(payload.error || "The analysis request failed.");
      }

      setJob(payload);
    } catch (requestError) {
      setError(requestError.message || "Unable to process the workbook.");
      setIsSubmitting(false);
    }
  }

  async function handleStop() {
    if (!job?.jobId || !["queued", "running", "stopping"].includes(job.status)) {
      return;
    }

    try {
      setError("");
      const response = await fetch(buildApiUrl(`/api/jobs/${job.jobId}/stop`), {
        method: "POST",
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(payload.error || "Unable to stop the analysis job.");
      }
      setJob(payload);
    } catch (stopError) {
      setError(stopError.message || "Unable to stop the analysis job.");
    }
  }

  const progress = job || result;
  const summary = progress?.summary;
  const progressStatus =
    progress?.status === "running"
      ? `Analyzing ${progress.currentDistrictName || "districts"}`
      : progress?.status === "stopping"
        ? `Stopping after ${progress.currentDistrictName || "the current district"}`
        : progress?.status === "cancelled"
          ? "Analysis stopped"
          : progress?.status === "completed"
            ? "Analysis complete"
            : progress?.status === "failed"
              ? "Analysis stopped"
              : null;

  return (
    <main className="page-shell">
      <section className="hero-card">
        <h1>School District BoardDocs Analyzer</h1>
        <p className="hero-copy">
          Upload district workbooks and run them through a fast Stage 1 scan
          or a stricter Stage 2 BoardDocs verification flow.
        </p>

        <div className="info-grid">
          <article className="info-panel">
            <h2>Input</h2>
            <p>
              First sheet with a district name column and a website column. The
              processor supports <strong>.xlsx</strong>, <strong>.xlsm</strong>,
              and <strong>.csv</strong>.
            </p>
          </article>
          <article className="info-panel">
            <h2>Output</h2>
            <p>{stage.outputDescription}</p>
          </article>
        </div>
      </section>

      <section className="workspace-card">
        <div className="mode-switch" role="tablist" aria-label="Analysis stages">
          {Object.values(stages).map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`mode-tab ${mode.id === stageId ? "is-active" : ""}`}
              onClick={() => {
                setStageId(mode.id);
                setError("");
                setPartialResult(null);
                setJob(null);
                setResult(null);
              }}
            >
              <span className="mode-tab-title">{mode.eyebrow}</span>
              <span className="mode-tab-copy">{mode.title}</span>
            </button>
          ))}
        </div>

        <div className="workspace-header">
          <div>
            <p className="eyebrow">{stage.eyebrow}</p>
            <h2>{stage.title}</h2>
            <p className="stage-copy">{stage.subtitle}</p>
          </div>
          <span className="status-pill">
            {progressStatus || (isSubmitting ? stage.runningLabel : apiStatus)}
          </span>
        </div>

        <form className="upload-form" onSubmit={handleSubmit}>
          <label className="file-input-card" htmlFor="district-workbook">
            <span className="file-input-label">Input workbook</span>
            <span className="file-input-name">
              {file ? file.name : "Select your district workbook"}
            </span>
            <input
              id="district-workbook"
              type="file"
              accept=".xlsx,.xlsm,.csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <div className="form-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? stage.runningLabel : stage.buttonLabel}
            </button>
            {job?.jobId && ["queued", "running", "stopping"].includes(job.status) ? (
              <button
                className="secondary-button"
                type="button"
                onClick={handleStop}
                disabled={job.status === "stopping"}
              >
                {job.status === "stopping" ? "Stopping..." : "Stop"}
              </button>
            ) : null}
          </div>
        </form>

        <p className="helper-copy">{stage.helperCopy}</p>

        {error ? <div className="feedback error-box">{error}</div> : null}
        {partialResult?.downloadUrl ? (
          <div className="feedback partial-box">
            Partial workbook available:{" "}
            <a className="download-link inline-link" href={buildDownloadUrl(partialResult.downloadUrl)}>
              Download partial output
            </a>
            {partialResult.remainingDownloadUrl ? (
              <>
                {" "}and{" "}
                <a
                  className="download-link inline-link"
                  href={buildDownloadUrl(partialResult.remainingDownloadUrl)}
                >
                  download remaining districts
                </a>
              </>
            ) : null}
          </div>
        ) : null}

        {progress ? (
          <section className="result-panel">
            <div className="workspace-header">
              <div>
                <p className="eyebrow">Progress</p>
                <h2>
                  {progress.status === "completed"
                    ? "Workbook ready"
                    : progress.status === "cancelled"
                      ? "Run stopped"
                      : progress.status === "failed"
                        ? "Run stopped"
                        : progress.status === "stopping"
                          ? "Stopping after current district"
                          : "Analysis running"}
                </h2>
              </div>
              {progress.downloadUrl ? (
                <a
                  className="download-link"
                  href={buildDownloadUrl(progress.downloadUrl)}
                >
                  {progress.status === "completed" ? "Download output" : "Download checkpoint"}
                </a>
              ) : null}
            </div>

            <div className="metric-grid">
              <article className="metric-card">
                <span>Total districts</span>
                <strong>{formatNumber(progress.totalDistricts)}</strong>
              </article>
              <article className="metric-card">
                <span>Completed</span>
                <strong>{formatNumber(progress.completedDistricts)}</strong>
              </article>
              <article className="metric-card">
                <span>Remaining</span>
                <strong>{formatNumber(progress.remainingDistricts)}</strong>
              </article>
              <article className="metric-card">
                <span>Elapsed</span>
                <strong>{formatDuration(progress.elapsedSeconds)}</strong>
              </article>
            </div>

            <div className="result-note">
              Current district(s):{" "}
              <strong>{progress.currentDistrictName || "Waiting for the next district"}</strong>
            </div>

            <div className="result-note">
              Estimated time remaining:{" "}
              <strong>
                {progress.estimatedSecondsRemaining
                  ? formatDuration(progress.estimatedSecondsRemaining)
                  : "Calculating..."}
              </strong>
            </div>

            {progress.remainingDownloadUrl && progress.status !== "completed" ? (
              <div className="result-note">
                Remaining districts file:{" "}
                <a
                  className="download-link inline-link"
                  href={buildDownloadUrl(progress.remainingDownloadUrl)}
                >
                  Download remaining districts
                </a>
              </div>
            ) : null}

            {summary ? (
              <>
                <div className="metric-grid summary-grid">
                  <article className="metric-card">
                    <span>{stage.positiveLabel}</span>
                    <strong>{formatNumber(summary.boardDocsCount)}</strong>
                  </article>
                  <article className="metric-card">
                    <span>{stage.negativeLabel}</span>
                    <strong>{formatNumber(summary.nonBoardDocsCount)}</strong>
                  </article>
                </div>

                <div className="result-note">
                  Output file: <strong>{result.fileName}</strong>
                </div>
              </>
            ) : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}
