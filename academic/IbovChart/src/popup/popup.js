document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("show-chart");
  const chartCanvas = document.getElementById("ibovChart");
  const fallback = document.getElementById("chart-fallback");
  const htmlLegendContainer = document.getElementById("html-legend");

  let chartInstance = null;

  // Draw percentage labels INSIDE slices using the RAW percent value we pass
  const PercentageLabels = {
    id: "percentageLabels",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const dataset = chart.data.datasets[0];
      const meta = chart.getDatasetMeta(0);
      if (!dataset || !meta) return;

      ctx.save();
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      meta.data.forEach((arc, i) => {
        const rawPct = (dataset.rawPercents?.[i] ?? dataset.data[i]) || 0; // value is already in %
        if (!isFinite(rawPct) || rawPct < 1.2) return; // skip very small slices
        const { x, y } = arc.tooltipPosition();
        const text = `${rawPct.toFixed(1)}%`;

        // stroke for contrast
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.strokeText(text, x, y);

        ctx.fillStyle = "#fff";
        ctx.fillText(text, x, y);
      });

      ctx.restore();
    }
  };

  // Custom HTML legend (scrollable) with hover → highlight slice & show tooltip
  const HtmlLegend = {
    id: "htmlLegend",
    afterUpdate(chart) {
      const ul = buildLegendList(chart);
      // Replace content
      htmlLegendContainer.innerHTML = "";
      htmlLegendContainer.appendChild(ul);
    }
  };

  function buildLegendList(chart) {
    const ul = document.createElement("ul");
    const labels = chart.data.labels;
    const colors = chart.data.datasets[0].backgroundColor;
    const meta = chart.getDatasetMeta(0);

    labels.forEach((label, i) => {
      const li = document.createElement("li");
      li.setAttribute("data-index", String(i));

      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = colors[i];

      const text = document.createElement("span");
      text.textContent = label;

      li.appendChild(swatch);
      li.appendChild(text);

      // Hover: highlight arc + show tooltip at arc center
      li.addEventListener("mouseenter", () => {
        const arc = meta.data[i];
        if (!arc) return;

        const center = arc.getCenterPoint();
        chart.setActiveElements([{ datasetIndex: 0, index: i }]);
        if (chart.tooltip?.setActiveElements) {
          chart.tooltip.setActiveElements([{ datasetIndex: 0, index: i }], {
            x: center.x,
            y: center.y
          });
        }
        chart.update();
      });

      li.addEventListener("mouseleave", () => {
        chart.setActiveElements([]);
        if (chart.tooltip?.setActiveElements) {
          chart.tooltip.setActiveElements([], { x: 0, y: 0 });
        }
        chart.update();
      });

      ul.appendChild(li);
    });

    return ul;
  }

  // Group by 4-letter root (PETR3 + PETR4 → PETR) and keep ALL groups
  function groupByRoot(shares) {
    const map = new Map();
    for (const item of shares) {
      const t = String(item.ticker || item.codigo || "").toUpperCase();
      const match = t.match(/[A-Z]{4}/);
      if (!match) continue;
      const root = match[0];
      const pct = Number(item.partPct) || 0;
      map.set(root, (map.get(root) || 0) + pct);
    }
    return Array.from(map.entries())
      .map(([root, partPct]) => ({ root, partPct }))
      .sort((a, b) => b.partPct - a.partPct);
  }

  // Generate many visually distinct colors
  function makePalette(n) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const hue = Math.round((360 * i) / n);          // spread hues evenly
      const sat = 70;                                  // saturation
      const light = 55;                                // lightness
      arr.push(`hsl(${hue} ${sat}% ${light}%)`);
    }
    return arr;
  }

  btn.addEventListener("click", async () => {
    fallback.textContent = "";

    const result = await chrome.storage.local.get("ibov_shares");
    const shares = result.ibov_shares;

    if (!shares || shares.length === 0) {
      fallback.textContent = "No Ibovespa data found.";
      return;
    }

    // Group ALL by root
    const grouped = groupByRoot(shares);

    const labels = grouped.map(d => d.root);
    const values = grouped.map(d => Number(d.partPct)); // already in %
    const colors = makePalette(values.length);

    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(chartCanvas, {
      type: "pie",
      data: {
        labels,
        datasets: [
          {
            data: values,              // used by Chart.js
            rawPercents: values,       // used by our label plugin for exact % values
            backgroundColor: colors
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: false },  // we use the HTML legend instead
          tooltip: {
            callbacks: {
              // Show exact percent with 2 decimals in tooltip
              label: (ctx) => {
                const label = ctx.label || "";
                const val = ctx.raw ?? 0;
                return `${label}: ${Number(val).toFixed(2)}%`;
              }
            }
          },
          title: {
            display: true,
            text: "Ibovespa (%) — grouped by 4-letter root"
          }
        }
      },
      plugins: [PercentageLabels, HtmlLegend]
    });
  });
});
