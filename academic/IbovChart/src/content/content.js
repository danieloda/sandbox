// Extract Ibovespa weights from the B3 composition table.
// Works whether this script runs in the top page or inside the embedded iframe.
// Strategy:
// 1) Find the table in the CURRENT document.
// 2) Try to switch "results per page" to 120 via #selectPage.
// 3) If still paginated, click pages 2..N and aggregate all rows.
// 4) Save to chrome.storage.local as { ticker, partPct }.

(function () {
  // -----------------------
  // Utilities
  // -----------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parsePtNumber(str) {
    // "1.234,56" -> 1234.56
    return Number(String(str).trim().replace(/\./g, "").replace(",", "."));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function tableInThisDocument() {
    // This is the table class used by B3 for the composition grid
    return document.querySelector("table.table-responsive-sm.table-responsive-md");
  }

  function extractRowsFromTable(table) {
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    const out = [];
    for (const tr of rows) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 5) continue;
      const ticker = tds[0].textContent.trim();
      const partPct = parsePtNumber(tds[4].textContent);
      if (ticker && !Number.isNaN(partPct)) out.push({ ticker, partPct });
    }
    return out;
  }

  function normalizeTo100(data) {
    const total = data.reduce((s, d) => s + d.partPct, 0);
    if (!total || Math.abs(total - 100) < 0.01) return data;
    return data.map((d) => ({ ...d, partPct: (d.partPct / total) * 100 }));
  }

  function save(data) {
    chrome.storage.local.set(
      { ibov_shares: data, ibov_updated_at: new Date().toISOString() },
      () => console.log(`[B3] Saved ${data.length} rows to chrome.storage.local`)
    );
  }

  function tableSignature(table) {
    const rows = table.querySelectorAll("tbody tr");
    if (!rows.length) return "";
    const first = rows[0].querySelector("td")?.textContent?.trim() || "";
    const last = rows[rows.length - 1].querySelector("td")?.textContent?.trim() || "";
    return `${first}__${last}__${rows.length}`;
  }

  async function waitForTablePresent(attempts = 20, intervalMs = 500) {
    for (let i = 1; i <= attempts; i++) {
      const t = tableInThisDocument();
      if (t) return t;
      console.log(`[B3] Waiting for table (attempt ${i})…`);
      await sleep(intervalMs);
    }
    return null;
  }

  async function waitForRowsChange(table, prevSig, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const sig = tableSignature(table);
      if (sig && sig !== prevSig) return sig;
      await sleep(150);
    }
    return tableSignature(table);
  }

  // -----------------------
  // Results-per-page handling
  // -----------------------
  async function trySetResultsPerPage120(docTable) {
    const sel =
      document.getElementById("selectPage") ||
      Array.from(document.querySelectorAll("select")).find((s) =>
        Array.from(s.options).some((o) => o.textContent.trim() === "120")
      );

    if (!sel || !isVisible(sel)) {
      console.log("[B3] #selectPage not found/visible — will paginate instead.");
      return false;
    }

    // Resolve the proper value for the "120" option
    const optByText = Array.from(sel.options).find(
      (o) => o.textContent.trim() === "120"
    );
    if (!optByText) {
      console.log("[B3] '120' option not present — will paginate instead.");
      return false;
    }

    const targetValue = optByText.value;

    if (sel.value !== targetValue) {
      const prevSig = tableSignature(docTable);

      // Change and notify Angular/React
      sel.value = targetValue;
      sel.selectedIndex = Array.from(sel.options).findIndex(
        (o) => o.value === targetValue
      );
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      console.log("[B3] Changed results-per-page to 120, waiting for update…");

      // Wait the table to change
      await waitForRowsChange(docTable, prevSig, 8000);
      return true;
    }

    // Already at 120
    return true;
  }

  // -----------------------
  // Pagination crawler
  // -----------------------
  function findPaginationButtons() {
    // Look for numeric page buttons anywhere in the current document (inside this frame)
    const candidates = Array.from(
      document.querySelectorAll("a, button, span, li, div")
    ).filter((el) => /^\d+$/.test(el.textContent.trim()) && isVisible(el));

    // Deduplicate by number
    const map = new Map();
    for (const el of candidates) {
      const num = el.textContent.trim();
      if (!map.has(num)) map.set(num, el);
    }

    return Array.from(map.entries())
      .map(([num, el]) => ({ num: Number(num), el }))
      .sort((a, b) => a.num - b.num);
  }

  function robustClick(el) {
    try {
      el.focus?.();
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Fallback to native click if available
      el.click?.();
      return true;
    } catch (e) {
      console.log("[B3] Click failed:", e);
      return false;
    }
  }

  async function crawlAllPages(table) {
    // Try to switch to 120 first; if it works, often there will be a single page
    const switched = await trySetResultsPerPage120(table);

    const aggregated = [];
    const seen = new Set();
    const pushUnique = (rows) => {
      for (const r of rows) {
        if (!seen.has(r.ticker)) {
          seen.add(r.ticker);
          aggregated.push(r);
        }
      }
    };

    // Start with current page
    pushUnique(extractRowsFromTable(table));
    let sig = tableSignature(table);

    // If still paginated, find pages 2..N and click through
    const pages = findPaginationButtons();
    const pageNums = pages.map((p) => p.num);

    if (pageNums.length <= 1 && switched) {
      console.log("[B3] Single page after switching to 120 — no crawl needed.");
      return aggregated;
    }

    if (!pages.length) {
      console.log("[B3] No pagination controls detected — using current page only.");
      return aggregated;
    }

    console.log("[B3] Pagination detected:", pageNums.join(", "));

    for (const p of pages) {
      if (p.num === 1) continue; // already captured
      console.log(`[B3] Going to page ${p.num}…`);
      robustClick(p.el);

      sig = await waitForRowsChange(table, sig, 8000);
      pushUnique(extractRowsFromTable(table));
      console.log(`[B3] Page ${p.num} captured. Unique tickers: ${aggregated.length}`);
      await sleep(250);
    }

    return aggregated;
  }

  // -----------------------
  // Main
  // -----------------------
  async function run() {
    // 1) Wait for the table IN THIS DOCUMENT (top page or iframe)
    const table = await waitForTablePresent(20, 500);
    if (!table) {
      console.warn("[B3] Ibovespa table not found.");
      return;
    }

    // 2) Crawl / aggregate and save
    const rows = await crawlAllPages(table);
    const data = normalizeTo100(rows);
    save(data);
  }

  if (document.readyState === "complete") {
    run();
  } else {
    window.addEventListener("load", run);
  }
})();
