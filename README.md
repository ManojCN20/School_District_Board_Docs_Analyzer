# School District BoardDocs Analyzer

A full-stack project that accepts an input workbook of school districts and website links, checks whether each district appears to manage board materials in BoardDocs beyond policy-only pages, and generates a new workbook with two sheets:

1. `BoardDocs Districts`
2. `Non BoardDocs Districts`

## Stack

- React frontend for file upload and results download
- Node.js + Express API for upload orchestration
- Python worker for Excel processing and website analysis

## Expected Input

The app reads the first sheet in the uploaded workbook and looks for:

- A district name column such as `School District Name`, `District`, or `District Name`
- A website column such as `Website`, `Website Link`, `URL`, or `Web Site`

The processor supports `.xlsx`, `.xlsm`, and `.csv` inputs.

## Output Workbook

The generated workbook contains:

- `BoardDocs Districts` with `School District Name`, `Website Link`, and `BoardDocs Link`
- `Non BoardDocs Districts` with `School District Name` and `Website Link`

## Classification Logic

The Python worker:

1. Loads the district rows from the first sheet.
2. Visits the district website.
3. Looks for direct or nearby references to BoardDocs.
4. Tries to distinguish broader board-document usage from policy-only references.

If a BoardDocs reference is found and the evidence suggests agendas, meetings, minutes, or other board-material usage beyond policies alone, the district is placed in the `BoardDocs Districts` sheet.

## Run Locally

Install Python dependencies once:

```bash
python3 -m pip install -r requirements.txt
```

Then start the app:

```bash
npm run dev
```

That starts:

- React UI at `http://localhost:5173`
- Express API at `http://localhost:3001`

For a production build:

```bash
npm run build
npm start
```

## Deploy On Netlify

Netlify is a good fit for the React frontend in this repo. The current backend is not Netlify-ready as-is because this project uses:

- an Express server
- a Python worker
- local output files under `data/outputs/`

The easiest deployment model is:

1. Deploy the frontend on Netlify
2. Deploy the Node.js + Python backend on another host
3. Point the frontend to that backend with `VITE_API_BASE_URL`

### Files already prepared

- `netlify.toml` sets the Netlify build command and publish directory
- `.env.example` shows the frontend API base URL variable

### Netlify frontend deployment

In Netlify:

- Build command: `npm run build`
- Publish directory: `client/dist`

Add this environment variable in Netlify before deploying:

```bash
VITE_API_BASE_URL=https://your-backend.example.com
```

Then connect the repository and deploy.

### Important

If you deploy only the frontend to Netlify without a separate backend, the upload and analysis flow will not work.

## Deploy Backend On Render

The easiest first deployment for the backend is a single Render web service that runs:

- the Express API
- the Python analyzer
- the built React files served by Express

This repo now includes:

- [Dockerfile](/Users/manojcn/Documents/Codex/2026-04-23-i-want-to-create-a-project/Dockerfile)
- [render.yaml](/Users/manojcn/Documents/Codex/2026-04-23-i-want-to-create-a-project/render.yaml)
- [.dockerignore](/Users/manojcn/Documents/Codex/2026-04-23-i-want-to-create-a-project/.dockerignore)

### Recommended first deployment

1. Push this project to GitHub.
2. Create a new Render `Web Service`.
3. Choose the repository.
4. Select `Docker` as the runtime.
5. Render will use [Dockerfile](/Users/manojcn/Documents/Codex/2026-04-23-i-want-to-create-a-project/Dockerfile).
6. Set the health check path to:

```text
/api/health
```

7. Deploy the service.

After deployment, open:

```text
https://your-render-service.onrender.com/api/health
```

You should get JSON showing `ok: true` and `pythonReady: true`.

### Environment variables

The backend works without extra variables, but these are the useful ones:

```bash
PYTHON_BIN=python3
DATA_ROOT=/app/data
CORS_ORIGIN=https://your-netlify-site.netlify.app
```

- `PYTHON_BIN` tells the API which Python executable to use
- `DATA_ROOT` controls where uploaded files and generated output workbooks are stored
- `CORS_ORIGIN` should be set to your Netlify frontend domain once the frontend is deployed

### Persistent output files

Render services use an ephemeral filesystem by default. That means uploaded files and generated workbooks disappear when the service restarts or redeploys.

For your current app, that is acceptable for quick testing because users normally upload a workbook and download the result immediately. If you want outputs to survive restarts, attach a Render persistent disk and set:

```bash
DATA_ROOT=/app/data
```

Recommended mount path:

```text
/app/data
```

Important:

- a persistent disk requires a paid Render service
- a service with a persistent disk cannot scale to multiple instances
- adding a disk disables zero-downtime deploys for that service

### Render Blueprint option

If you want Render to read the deployment config from the repo, use [render.yaml](/Users/manojcn/Documents/Codex/2026-04-23-i-want-to-create-a-project/render.yaml). It creates one Docker-based web service with:

- `runtime: docker`
- `plan: free`
- `healthCheckPath: /api/health`

You can change the plan in Render later if you need more throughput.

## Project Structure

```text
client/
  index.html
  src/
server/
  index.js
python-workdir/
  analyze_districts.py
data/
  uploads/
  outputs/
```

## Notes

- District websites can be inconsistent, so the BoardDocs classification is heuristic rather than absolute.
- The app keeps generated workbooks under `data/outputs/`.
- If a district website is missing or inaccessible, the district is placed in the non-BoardDocs sheet.
- If the backend picks the wrong Python runtime, start it with `PYTHON_BIN=/full/path/to/python3 npm run dev:server`.
