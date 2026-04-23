import { useState } from "react";

const initialResult = null;
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
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

export default function App() {
  const [file, setFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(initialResult);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!file) {
      setError("Choose an input workbook before starting the analysis.");
      return;
    }

    setError("");
    setResult(null);
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(buildApiUrl("/api/analyze"), {
        method: "POST",
        body: formData,
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "The analysis request failed.");
      }

      setResult(payload);
    } catch (requestError) {
      setError(requestError.message || "Unable to process the workbook.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const summary = result?.summary;

  return (
    <main className="page-shell">
      <section className="hero-card">
        <h1>School District BoardDocs Analyzer</h1>
        <p className="hero-copy">
          Upload a workbook of school districts and website links. The app
          checks each district site, looks for BoardDocs usage beyond
          policy-only pages, and returns a clean two-sheet Excel output.
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
            <p>
              One sheet for districts using BoardDocs for broader board
              documentation, and another for districts that do not match that
              pattern.
            </p>
          </article>
        </div>
      </section>

      <section className="workspace-card">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Analysis</p>
            <h2>Run the workbook scan</h2>
          </div>
          <span className="status-pill">
            {isSubmitting ? "Processing districts..." : "Ready"}
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

          <button
            className="primary-button"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? "Analyzing workbook..."
              : "Generate output workbook"}
          </button>
        </form>

        <p className="helper-copy">
          A district is counted as BoardDocs only when the crawler finds a
          BoardDocs reference and the surrounding evidence suggests board
          materials beyond policies alone.
        </p>

        {error ? <div className="feedback error-box">{error}</div> : null}

        {summary ? (
          <section className="result-panel">
            <div className="workspace-header">
              <div>
                <p className="eyebrow">Results</p>
                <h2>Workbook ready</h2>
              </div>
              <a
                className="download-link"
                href={buildDownloadUrl(result.downloadUrl)}
              >
                Download output
              </a>
            </div>

            <div className="metric-grid">
              <article className="metric-card">
                <span>Total districts</span>
                <strong>{formatNumber(summary.totalDistricts)}</strong>
              </article>
              <article className="metric-card">
                <span>BoardDocs districts</span>
                <strong>{formatNumber(summary.boardDocsCount)}</strong>
              </article>
              <article className="metric-card">
                <span>Non BoardDocs districts</span>
                <strong>{formatNumber(summary.nonBoardDocsCount)}</strong>
              </article>
              <article className="metric-card">
                <span>Elapsed seconds</span>
                <strong>{formatNumber(summary.elapsedSeconds)}</strong>
              </article>
            </div>

            <div className="result-note">
              Output file: <strong>{result.fileName}</strong>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
