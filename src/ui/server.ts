import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { getSequenceContext, listMoleculeSummaries } from "../core/context.js";
import { MoleculeError } from "../core/errors.js";
import type { Feature } from "../core/schema.js";
import { readWorkspace } from "../core/workspace.js";
import { upsertFeature } from "../core/writes.js";
import { toolFailureFromError } from "../tools/envelope.js";

export type SequenceEditorServerOptions = {
  workspacePath: string;
  moleculeId?: string;
  host?: string;
  port?: number;
};

export type SequenceEditorServer = {
  url: string;
  workspacePath: string;
  close: () => Promise<void>;
};

export async function startSequenceEditorServer(options: SequenceEditorServerOptions): Promise<SequenceEditorServer> {
  const workspacePath = path.resolve(options.workspacePath);
  await readWorkspace(workspacePath, { checkSequenceDigests: true });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const server = createServer((request, response) => {
    void handleRequest(request, response, workspacePath, options.moleculeId).catch((error) => {
      sendJson(response, 500, toolFailureFromError("open_sequence_editor", error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new MoleculeError("INTERNAL_ERROR", "Sequence editor server did not expose a TCP address.", { address });
  }

  return {
    url: `http://${host}:${address.port}/`,
    workspacePath,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workspacePath: string,
  defaultMoleculeId?: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, renderEditorHtml(defaultMoleculeId));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workspace") {
    const workspace = await readWorkspace(workspacePath, { checkSequenceDigests: true });
    const molecules = await listMoleculeSummaries(workspacePath);
    sendJson(response, 200, {
      ok: true,
      workspacePath,
      revision: workspace.revision,
      molecules: molecules.molecules,
      features: workspace.features,
      primers: workspace.primers,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/context") {
    const moleculeId = url.searchParams.get("moleculeId") ?? defaultMoleculeId;
    if (!moleculeId) {
      sendJson(response, 400, { ok: false, error: { code: "INVALID_ARGUMENT", message: "moleculeId is required." } });
      return;
    }
    const start = numberParam(url, "start");
    const end = numberParam(url, "end");
    const context = await getSequenceContext(workspacePath, moleculeId, {
      ...(start !== undefined && end !== undefined ? { region: { start, end, strand: "+" } } : {}),
      includeSequence: url.searchParams.get("includeSequence") === "true",
    });
    sendJson(response, 200, { ok: true, workspacePath, ...context });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/features") {
    const body = await readJsonBody(request);
    const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : Number.NaN;
    const feature = body.feature as Feature | undefined;
    if (feature === undefined) {
      sendJson(response, 400, { ok: false, error: { code: "INVALID_ARGUMENT", message: "feature is required." } });
      return;
    }
    const result = await upsertFeature(workspacePath, expectedRevision, feature);
    sendJson(response, 200, { ok: true, workspacePath, revision: result.revision, data: result.payload });
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Route not found." } });
}

function renderEditorHtml(defaultMoleculeId?: string): string {
  const initialMolecule = JSON.stringify(defaultMoleculeId ?? "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Molecule Editor</title>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f8;
      color: #18201f;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    button, input, select { font: inherit; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 280px 1fr; }
    .side { background: #10201d; color: #f7fbf9; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .brand { font-size: 15px; font-weight: 700; letter-spacing: 0; }
    .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .metric { border: 1px solid #29423d; border-radius: 6px; padding: 8px; background: #162b27; }
    .metric span { display: block; font-size: 11px; color: #aac1bb; }
    .metric strong { display: block; margin-top: 3px; font-size: 15px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    label { font-size: 12px; color: #bbcbc7; }
    select, input { width: 100%; border: 1px solid #cbd4d1; border-radius: 5px; padding: 7px 8px; background: #fff; color: #18201f; }
    .side input, .side select { border-color: #36534d; background: #0d1917; color: #f7fbf9; }
    .main { padding: 18px; display: grid; grid-template-rows: auto minmax(160px, 1fr) auto; gap: 14px; }
    .toolbar { display: grid; grid-template-columns: 1fr repeat(3, minmax(90px, 120px)) auto; gap: 8px; align-items: end; }
    .panel { background: #fff; border: 1px solid #d8dfdd; border-radius: 7px; overflow: hidden; }
    .panel h2 { margin: 0; padding: 10px 12px; font-size: 13px; background: #e9efec; border-bottom: 1px solid #d8dfdd; }
    .sequence { margin: 0; padding: 12px; min-height: 140px; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.55; }
    .tracks { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 7px 8px; border-bottom: 1px solid #edf1ef; text-align: left; vertical-align: top; }
    th { color: #53615d; font-weight: 700; background: #fbfcfc; }
    .form { display: grid; grid-template-columns: repeat(6, 1fr) auto; gap: 8px; padding: 12px; align-items: end; }
    .primary { border: 0; border-radius: 5px; background: #1f6f5b; color: #fff; padding: 8px 10px; min-height: 34px; cursor: pointer; }
    .primary:disabled { background: #91aaa2; cursor: default; }
    .status { min-height: 18px; color: #5d6a66; font-size: 12px; }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      .toolbar, .form, .tracks { grid-template-columns: 1fr; }
      .side { min-height: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="side">
      <div class="brand">Molecule Biology</div>
      <div class="field">
        <label for="molecule">Molecule</label>
        <select id="molecule"></select>
      </div>
      <div class="meta">
        <div class="metric"><span>Revision</span><strong id="revision">-</strong></div>
        <div class="metric"><span>Length</span><strong id="length">-</strong></div>
        <div class="metric"><span>Topology</span><strong id="topology">-</strong></div>
        <div class="metric"><span>Type</span><strong id="type">-</strong></div>
      </div>
      <div class="status" id="status"></div>
    </aside>
    <main class="main">
      <section class="toolbar">
        <div class="field"><label for="region-start">Start</label><input id="region-start" inputmode="numeric" value="1"></div>
        <div class="field"><label for="region-end">End</label><input id="region-end" inputmode="numeric" value="120"></div>
        <button class="primary" id="load-region">Load</button>
      </section>
      <section class="panel">
        <h2>Sequence</h2>
        <pre class="sequence" id="sequence"></pre>
      </section>
      <section class="tracks">
        <div class="panel">
          <h2>Features</h2>
          <table><thead><tr><th>Name</th><th>Type</th><th>Segments</th></tr></thead><tbody id="features"></tbody></table>
          <div class="form">
            <input id="feature-id" placeholder="id">
            <input id="feature-name" placeholder="name">
            <input id="feature-type" placeholder="type">
            <input id="feature-start" placeholder="start" inputmode="numeric">
            <input id="feature-end" placeholder="end" inputmode="numeric">
            <select id="feature-strand"><option>+</option><option>-</option><option>none</option></select>
            <button class="primary" id="add-feature">Save</button>
          </div>
        </div>
        <div class="panel">
          <h2>Primers</h2>
          <table><thead><tr><th>Name</th><th>Sequence</th><th>Binding</th></tr></thead><tbody id="primers"></tbody></table>
        </div>
      </section>
    </main>
  </div>
  <script>
    const initialMoleculeId = ${initialMolecule};
    const state = { revision: -1, moleculeId: initialMoleculeId, molecules: [] };
    const $ = (id) => document.getElementById(id);

    async function json(url, options) {
      const response = await fetch(url, options);
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error?.message || "Request failed");
      return payload;
    }

    function segmentText(segments) {
      return (segments || []).map((s) => s.start + ".." + s.end + " " + s.strand).join(", ");
    }

    function rows(target, items, mapper) {
      target.replaceChildren(...items.map((item) => {
        const tr = document.createElement("tr");
        mapper(item).forEach((text) => {
          const td = document.createElement("td");
          td.textContent = text;
          tr.appendChild(td);
        });
        return tr;
      }));
    }

    async function loadWorkspace(force) {
      const payload = await json("/api/workspace");
      if (!force && payload.revision === state.revision) return;
      state.revision = payload.revision;
      state.molecules = payload.molecules;
      if (!state.moleculeId && payload.molecules[0]) state.moleculeId = payload.molecules[0].id;
      $("revision").textContent = String(payload.revision);
      const select = $("molecule");
      select.replaceChildren(...payload.molecules.map((molecule) => {
        const option = document.createElement("option");
        option.value = molecule.id;
        option.textContent = molecule.name + " (" + molecule.id + ")";
        option.selected = molecule.id === state.moleculeId;
        return option;
      }));
      const molecule = payload.molecules.find((item) => item.id === state.moleculeId);
      $("length").textContent = molecule ? String(molecule.length) : "-";
      $("topology").textContent = molecule ? molecule.topology : "-";
      $("type").textContent = molecule ? molecule.moleculeType : "-";
      rows($("features"), payload.features.filter((item) => item.moleculeId === state.moleculeId), (item) => [item.name, item.type, segmentText(item.segments)]);
      rows($("primers"), payload.primers.filter((item) => item.moleculeId === state.moleculeId), (item) => [item.name, item.sequence, segmentText(item.binding?.segments)]);
      await loadContext();
    }

    async function loadContext() {
      if (!state.moleculeId) return;
      const start = Number($("region-start").value || "1");
      const end = Number($("region-end").value || "120");
      const payload = await json("/api/context?moleculeId=" + encodeURIComponent(state.moleculeId) + "&start=" + start + "&end=" + end + "&includeSequence=true");
      $("sequence").textContent = payload.sequence || "";
      $("status").textContent = "ready";
    }

    async function saveFeature() {
      const moleculeId = state.moleculeId;
      if (!moleculeId) return;
      const feature = {
        id: $("feature-id").value,
        moleculeId,
        name: $("feature-name").value,
        type: $("feature-type").value || "misc_feature",
        segments: [{ start: Number($("feature-start").value), end: Number($("feature-end").value), strand: $("feature-strand").value }],
      };
      $("add-feature").disabled = true;
      try {
        const payload = await json("/api/features", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: state.revision, feature }),
        });
        state.revision = payload.revision - 1;
        await loadWorkspace(true);
      } finally {
        $("add-feature").disabled = false;
      }
    }

    $("molecule").addEventListener("change", (event) => { state.moleculeId = event.target.value; void loadWorkspace(true); });
    $("load-region").addEventListener("click", () => { void loadContext(); });
    $("add-feature").addEventListener("click", () => { void saveFeature().catch((error) => { $("status").textContent = error.message; }); });
    void loadWorkspace(true);
    setInterval(() => { void loadWorkspace(false).catch(() => {}); }, 1500);
  </script>
</body>
</html>`;
}

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new MoleculeError("INVALID_ARGUMENT", `${name} must be an integer.`, { [name]: value });
  }
  return parsed;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MoleculeError("INVALID_ARGUMENT", "JSON body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
