import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const tmpDir = path.join(repoRoot, "tmp", "pdfs");
const outputDir = path.join(repoRoot, "output", "pdf");
const htmlPath = path.join(tmpDir, "quantum-seo-learning-guide.html");
const pdfPath = path.join(outputDir, "quantum-seo-learning-guide.pdf");
const chromeProfileDir = path.join(tmpDir, "chrome-profile");

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function resolveChromePath() {
  for (const candidate of chromeCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No supported Chrome or Edge binary was found. Install Chrome or Edge to generate the PDF.",
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderList(items) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderRows(rows) {
  return rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.area)}</td>
          <td>${escapeHtml(row.purpose)}</td>
          <td><code>${escapeHtml(row.path)}</code></td>
        </tr>`,
    )
    .join("");
}

const sections = {
  whatItIs: [
    "Quantum SEO is a search application with a browser frontend and a Python FastAPI backend.",
    "The backend exposes routes under /api and uses Postgres, Redis, and OpenSearch style services.",
    "The frontend is a static page that calls those backend endpoints with fetch.",
  ],
  beginnerSteps: [
    "Open backend/main.py first. This is the app entry point.",
    "Read backend/api/search.py to understand the route pattern.",
    "Read frontend/assets/app.js to see how the browser calls /api/search and /api/trending.",
    "Only after that, move into backend/search and backend/storage.",
  ],
  newApiSteps: [
    "Create a new file inside backend/api, for example backend/api/profile.py.",
    "Create router = APIRouter() in that file.",
    "Add a route such as @router.get('/profile').",
    "Import that router in backend/main.py.",
    "Register it with app.include_router(your_router, prefix='/api').",
    "If the frontend needs it, call it from frontend/assets/app.js using fetch('/api/profile').",
  ],
  practiceIdeas: [
    "Build /api/hello that returns your name and learning stage.",
    "Build /api/time that returns server time.",
    "Build /api/profile that returns a static JSON profile.",
    "Add one matching frontend button or fetch call to display the response.",
  ],
  commands: [
    "Run backend: uvicorn backend.main:app --reload --host 0.0.0.0 --port 3000",
    "Open app in browser: http://localhost:3000",
    "Run tests: python -m pytest tests",
  ],
};

const folderRows = [
  {
    area: "backend/api",
    purpose: "Best place to add new backend endpoints.",
    path: "backend/api/search.py, backend/api/health.py",
  },
  {
    area: "backend/search",
    purpose: "Search business logic and response building.",
    path: "backend/search/engine.py",
  },
  {
    area: "backend/storage",
    purpose: "Database and cache access code.",
    path: "backend/storage/postgres.py, backend/storage/redis.py",
  },
  {
    area: "frontend/assets",
    purpose: "Browser JavaScript and styles.",
    path: "frontend/assets/app.js, frontend/assets/styles.css",
  },
  {
    area: "tests",
    purpose: "Unit, integration, and end-to-end checks.",
    path: "tests/unit, tests/integration, tests/e2e",
  },
];

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quantum SEO Learning Guide</title>
    <style>
      @page {
        size: A4;
        margin: 18mm;
      }

      :root {
        --ink: #12202f;
        --muted: #506070;
        --line: #d6dde4;
        --panel: #f5f7fa;
        --brand: #0f766e;
        --accent: #d97706;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "Segoe UI", Arial, sans-serif;
        font-size: 11.5pt;
        line-height: 1.5;
      }

      .hero {
        padding: 18px 22px;
        border: 1px solid var(--line);
        border-radius: 16px;
        background:
          linear-gradient(135deg, rgba(15, 118, 110, 0.10), rgba(217, 119, 6, 0.10)),
          #ffffff;
      }

      .eyebrow {
        margin: 0 0 8px;
        color: var(--brand);
        font-size: 10pt;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h1 {
        margin: 0;
        font-size: 24pt;
        line-height: 1.15;
      }

      .hero p {
        margin: 12px 0 0;
        color: var(--muted);
      }

      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 14px;
      }

      .card {
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: var(--panel);
      }

      .card strong {
        color: var(--brand);
      }

      h2 {
        margin: 28px 0 10px;
        padding-bottom: 6px;
        border-bottom: 2px solid var(--line);
        font-size: 15pt;
      }

      h3 {
        margin: 16px 0 8px;
        font-size: 12pt;
      }

      p {
        margin: 8px 0;
      }

      ul, ol {
        margin: 8px 0 0 18px;
        padding: 0;
      }

      li {
        margin: 6px 0;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 10px;
        font-size: 10.5pt;
      }

      th, td {
        border: 1px solid var(--line);
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
      }

      th {
        background: #eef3f7;
      }

      code {
        font-family: Consolas, "Courier New", monospace;
        font-size: 9.5pt;
        background: #eef3f7;
        padding: 1px 4px;
        border-radius: 4px;
      }

      .callout {
        margin-top: 12px;
        padding: 12px 14px;
        border-left: 4px solid var(--accent);
        background: #fff7ed;
      }

      .two-column {
        columns: 2;
        column-gap: 22px;
      }

      .footer-note {
        margin-top: 24px;
        color: var(--muted);
        font-size: 9.5pt;
      }
    </style>
  </head>
  <body>
    <section class="hero">
      <p class="eyebrow">Project Learning PDF</p>
      <h1>Quantum SEO Beginner Guide</h1>
      <p>
        This PDF explains the current project structure, where backend APIs belong,
        and how you can start learning this repo without getting lost.
      </p>
      <div class="grid">
        <div class="card">
          <strong>Current stack</strong>
          <p>Static frontend + FastAPI backend + Postgres + Redis + OpenSearch style indexing.</p>
        </div>
        <div class="card">
          <strong>Main beginner goal</strong>
          <p>Learn how one frontend call reaches one backend API route and returns JSON.</p>
        </div>
      </div>
    </section>

    <h2>1. What This Project Is</h2>
    <ul>${renderList(sections.whatItIs)}</ul>

    <h2>2. Most Important Folders</h2>
    <table>
      <thead>
        <tr>
          <th>Folder</th>
          <th>Purpose</th>
          <th>Examples</th>
        </tr>
      </thead>
      <tbody>${renderRows(folderRows)}</tbody>
    </table>

    <h2>3. Where To Add A Backend API</h2>
    <p>
      The correct place to add a new backend endpoint in this repo is <code>backend/api</code>.
      Each file there defines one or more FastAPI routes using an <code>APIRouter</code>.
    </p>
    <ol>${renderList(sections.newApiSteps)}</ol>
    <div class="callout">
      Example path: create <code>backend/api/profile.py</code>, then import that router in
      <code>backend/main.py</code> and register it with prefix <code>/api</code>.
    </div>

    <h2>4. How The Request Flow Works</h2>
    <ol>
      <li>User opens the frontend page.</li>
      <li>The browser JavaScript sends a fetch request like <code>/api/search?q=topic</code>.</li>
      <li><code>backend/main.py</code> has already registered the route module.</li>
      <li>The route function inside <code>backend/api</code> reads the request.</li>
      <li>Business logic runs through search or storage modules.</li>
      <li>JSON response goes back to the frontend and gets rendered on screen.</li>
    </ol>

    <h2>5. Best Reading Order For Learning</h2>
    <ol>${renderList(sections.beginnerSteps)}</ol>

    <h2>6. Beginner Practice Tasks</h2>
    <div class="two-column">
      <ul>${renderList(sections.practiceIdeas)}</ul>
    </div>

    <h2>7. Important Files To Remember</h2>
    <ul>
      <li><code>backend/main.py</code> - app startup and route registration</li>
      <li><code>backend/api/search.py</code> - search API example</li>
      <li><code>backend/api/health.py</code> - simple API example</li>
      <li><code>frontend/assets/app.js</code> - frontend fetch calls to backend</li>
      <li><code>backend/search/engine.py</code> - main backend search logic</li>
    </ul>

    <h2>8. Commands To Run</h2>
    <ul>${renderList(sections.commands)}</ul>

    <h2>9. Final Advice</h2>
    <p>
      Do not start by reading every file. Start with one API route, one frontend fetch call,
      and one JSON response shape. Once that path is clear, the rest of the project becomes much easier.
    </p>
    <p>
      Good learning order: understand route registration, create one small API, test it,
      then connect it to the frontend.
    </p>

    <p class="footer-note">
      Generated from the current repo structure in G:\\Quantum_SEO on demand for learning use.
    </p>
  </body>
</html>`;

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(chromeProfileDir, { recursive: true });
fs.writeFileSync(htmlPath, html, "utf8");

const chromePath = resolveChromePath();
const htmlUrl = `file:///${htmlPath.replaceAll("\\", "/")}`;

execFileSync(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${chromeProfileDir}`,
    `--print-to-pdf=${pdfPath}`,
    "--print-to-pdf-no-header",
    htmlUrl,
  ],
  { stdio: "inherit" },
);

console.log(`HTML source: ${htmlPath}`);
console.log(`PDF created: ${pdfPath}`);
