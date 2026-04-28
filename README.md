# School District BoardDocs Analyzer

A full-stack project that accepts an input workbook of school districts and website links, supports a two-stage BoardDocs workflow, and generates output workbooks for each stage:

1. `Stage 1` finds districts with any BoardDocs usage at all
2. `Stage 2` verifies the stricter BoardDocs meetings workflow on a smaller list

## Stack

- React frontend for file upload and results download
- Node.js + Express API for upload orchestration
- Node.js analyzers for Excel processing and website analysis

## Expected Input

The app reads the first sheet in the uploaded workbook and looks for:

- A district name column such as `School District Name`, `District`, or `District Name`
- A website column such as `Website`, `Website Link`, `URL`, or `Web Site`

The processor supports `.xlsx`, `.xlsm`, and `.csv` inputs.

## Workflow

### Stage 1

The fast scanner:

1. Loads the district rows from the first sheet.
2. Fetches district pages with standard HTTP requests.
3. Looks for school-board-related links such as `School Board`, `Board of Education`, `Board Policies`, `Agenda`, `Minutes`, and similar paths.
4. Visits those targeted board-related pages and checks for any BoardDocs link or BoardDocs host reference.

The generated workbook contains:

- `BoardDocs Detected`
- `No BoardDocs Detected`

Each Stage 1 sheet now includes a `Pages Checked` column so you can see which district pages were inspected before the scanner decided whether any BoardDocs evidence was present.

### Stage 2

The stricter verifier:

1. Loads the district rows from the first sheet.
2. Reuses the fast BoardDocs discovery path from Stage 1.
3. Uses Playwright for the stricter BoardDocs verification step.
4. Looks for a BoardDocs link on the district website.
5. Visits the BoardDocs page, opens Meetings, and checks for a visible year such as `2024` or `2025`.

The generated workbook contains:

- `BoardDocs Districts`
- `Non BoardDocs Districts`

This is best run on the smaller Stage 1 positive set.

## Run Locally

Install Node dependencies once:

```bash
npm install
```

Install the Playwright browser once:

```bash
npm run setup:browser
```

Then start the app:

```bash
npm run dev
```

That starts:

- React UI at `http://localhost:5173`
- Express API at `http://localhost:3001`

Inside the UI:

- Use `Stage 1` for large uploads such as 500 to 1000 districts
- Use `Stage 2` for the smaller list that already showed BoardDocs presence

For a production build:

```bash
npm run build
npm start
```

## Deploy On Netlify

Netlify is a good fit for the React frontend in this repo. The current backend is not Netlify-ready as-is because this project uses:

- an Express server
- Playwright for the stricter verification step
- local output files under `data/outputs/`

The easiest deployment model is:

1. Deploy the frontend on Netlify
2. Deploy the Node.js backend on another host
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
- the Node.js analyzers
- the built React files served by Express

This repo now includes:

- [Dockerfile](./Dockerfile)
- [render.yaml](./render.yaml)
- [.dockerignore](./.dockerignore)

### Recommended first deployment

1. Push this project to GitHub.
2. Create a new Render `Web Service`.
3. Choose the repository.
4. Select `Docker` as the runtime.
5. Render will use [Dockerfile](./Dockerfile).
6. Set the health check path to:

```text
/api/health
```

7. Deploy the service.

After deployment, open:

```text
https://your-render-service.onrender.com/api/health
```

You should get JSON showing `ok: true` and `analyzerReady: true`.

### Environment variables

The backend works without extra variables, but these are the useful ones:

```bash
DATA_ROOT=/app/data
CORS_ORIGIN=https://your-netlify-site.netlify.app
```

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

If you want Render to read the deployment config from the repo, use [render.yaml](./render.yaml). It creates one Docker-based web service with:

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
  analyzers/
data/
  uploads/
  outputs/
```

## Notes

- District websites can be inconsistent, so the BoardDocs classification is heuristic rather than absolute.
- The app keeps generated workbooks under `data/outputs/`.
- If a district website is missing or inaccessible, the district is placed in the non-BoardDocs sheet.
- If Playwright is installed but Chromium is missing, run `npm run setup:browser`.
