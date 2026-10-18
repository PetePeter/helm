package com.potatomotato.helm.ui.time

import com.potatomotato.helm.data.TimeChartModel
import com.potatomotato.helm.data.TimeChartSeries
import com.potatomotato.helm.ui.artifacts.HtmlContainment
import org.json.JSONArray
import org.json.JSONObject

internal data class TimeChartTheme(
    val text: String,
    val textMuted: String,
    val grid: String,
    val tooltip: String,
    val surface: String,
)

/** Builds the trusted, self-contained Chart.js document hosted by ContainedWebView. */
internal object TimeChartDocument {
    fun build(
        model: TimeChartModel,
        chartBundle: String,
        theme: TimeChartTheme,
        stackedTokens: Boolean,
    ): String {
        require(chartBundle.isNotBlank()) { "The local Chart.js bundle is empty" }
        require(listOf(theme.text, theme.textMuted, theme.grid, theme.tooltip, theme.surface).all(HEX_COLOR::matches)) {
            "Chart theme colours must be six-digit hex values"
        }

        val modelJson = encodeModel(model, stackedTokens)
        return HtmlContainment.injectCsp(buildString {
            append("<!DOCTYPE html><html><head>")
            append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
            append("<style>")
            append(STYLE
                .replace("__TEXT__", theme.text)
                .replace("__MUTED__", theme.textMuted)
                .replace("__GRID__", theme.grid)
                .replace("__TOOLTIP__", theme.tooltip)
                .replace("__SURFACE__", theme.surface))
            append("</style></head><body>")
            append("<div id=\"plot\"><canvas id=\"chart\" aria-label=\"Statistics chart\"></canvas></div>")
            append("<div id=\"legend\" role=\"group\" aria-label=\"Chart series\"></div>")
            append("<script type=\"application/json\" id=\"chart-model\">")
            append(modelJson)
            append("</script><script>")
            append(HtmlContainment.inlineScript(chartBundle))
            append("</script><script>")
            append(INITIALISE
                .replace("__TEXT__", theme.text)
                .replace("__MUTED__", theme.textMuted)
                .replace("__GRID__", theme.grid)
                .replace("__TOOLTIP__", theme.tooltip))
            append("</script></body></html>")
        })
    }

    private fun encodeModel(model: TimeChartModel, stackedTokens: Boolean): String {
        val columns = JSONArray().apply { model.columns.forEach { put(it) } }
        val labels = JSONArray().apply { model.labels.forEach { put(it) } }
        val series = JSONArray().apply { model.series.forEach { put(it.toJson()) } }
        return JSONObject()
            .put("columns", columns)
            .put("labels", labels)
            .put("series", series)
            .put("stackedTokens", stackedTokens)
            .toString()
            // JSON sits inside a script element. Escaping HTML-significant
            // characters keeps labels as data even when they contain markup.
            .replace("&", "\\u0026")
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
    }

    private fun TimeChartSeries.toJson(): JSONObject {
        val values = JSONArray().apply { this@toJson.values.forEach { put(it) } }
        return JSONObject()
            .put("key", key)
            .put("label", label)
            .put("color", color)
            .put("type", type.wire)
            .put("axis", axis.wire)
            .put("values", values)
    }

    private const val STYLE = """
        *{box-sizing:border-box}
        html,body{width:100%;height:100%;margin:0;padding:0;background:transparent}
        body{display:flex;flex-direction:column;overflow:hidden;font-family:Roboto,Arial,sans-serif}
        #plot{position:relative;flex:1;min-height:0;overflow:hidden}
        #chart{display:block;width:100%;height:100%}
        #legend{position:relative;z-index:1;order:-1;display:flex;flex:0 0 56px;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;
          padding:4px 0;touch-action:pan-x;scrollbar-width:none}
        #legend::-webkit-scrollbar{display:none}
        #legend button{display:flex;flex:0 0 auto;align-items:center;gap:8px;min-width:48px;min-height:48px;
          padding:0 14px;border:1px solid __GRID__;border-radius:24px;background:__SURFACE__;color:__TEXT__;
          font:500 14px Roboto,Arial,sans-serif;white-space:nowrap;touch-action:manipulation}
        #legend button[aria-pressed=false]{opacity:.45}
        #legend .swatch{width:10px;height:10px;flex:none;border-radius:2px}
    """

    private const val INITIALISE = """
        (function(){
          const model = JSON.parse(document.getElementById('chart-model').textContent);
          const exactTokens = value => new Intl.NumberFormat('en-US').format(value);
          const compactTokens = value => {
            if (value >= 1e6) return Number((value / 1e6).toFixed(2)) + 'M';
            if (value >= 1e3) return Number((value / 1e3).toFixed(1)) + 'k';
            return exactTokens(value);
          };
          const formatMinuteValue = value => value === 0 ? '0m' :
            Math.floor(value / 60) + 'h' + String(Math.trunc(value % 60)).padStart(2, '0');
          const color = '__TEXT__';
          const muted = '__MUTED__';
          const grid = '__GRID__';
          const tooltip = '__TOOLTIP__';
          const chart = new Chart(document.getElementById('chart').getContext('2d'), {
            type: 'bar',
            data: {
              labels: model.labels,
              datasets: model.series.map(series => ({
                type: series.type,
                label: series.label,
                data: series.values.map(Number),
                backgroundColor: series.color,
                borderColor: series.color,
                borderWidth: series.type === 'line' ? 2 : 0,
                pointRadius: series.type === 'line' ? 2 : 0,
                tension: series.type === 'line' ? 0.25 : 0,
                yAxisID: series.axis,
                stack: model.stackedTokens ? 'tokens' : undefined
              }))
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: {mode: 'index', intersect: false},
              plugins: {
                legend: {display: false},
                tooltip: {
                  backgroundColor: tooltip,
                  titleColor: color,
                  bodyColor: color,
                  borderColor: grid,
                  borderWidth: 1,
                  callbacks: {
                    title: items => items[0]?.label ?? '',
                    label: item => {
                      const series = model.series[item.datasetIndex];
                      const value = Number(item.raw ?? 0);
                      const formatted = series.axis === 'tokens'
                        ? exactTokens(value) + ' tokens'
                        : formatMinuteValue(value);
                      return series.label + ': ' + formatted;
                    }
                  }
                }
              },
              scales: {
                x: {
                  stacked: model.stackedTokens,
                  ticks: {color: muted, autoSkip: true, maxTicksLimit: 12},
                  grid: {color: grid},
                  border: {color: grid}
                },
                minutes: {
                  type: 'linear',
                  display: !model.stackedTokens,
                  position: 'left',
                  stacked: false,
                  ticks: {color: muted, callback: value => formatMinuteValue(Number(value))},
                  grid: {color: grid},
                  border: {color: grid}
                },
                tokens: {
                  type: 'linear',
                  display: model.stackedTokens ? true : 'auto',
                  position: model.stackedTokens ? 'left' : 'right',
                  stacked: model.stackedTokens,
                  ticks: {color: muted, callback: value => compactTokens(Number(value))},
                  grid: {color: grid, drawOnChartArea: model.stackedTokens},
                  border: {color: grid}
                }
              }
            }
          });
          const legend = document.getElementById('legend');
          model.series.forEach((series, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('aria-pressed', 'true');
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(series.color) ? series.color : 'transparent';
            button.appendChild(swatch);
            button.appendChild(document.createTextNode(series.label));
            button.addEventListener('click', () => {
              const visible = chart.isDatasetVisible(index);
              chart.setDatasetVisibility(index, !visible);
              button.setAttribute('aria-pressed', String(!visible));
              chart.update();
            });
            legend.appendChild(button);
          });
        })();
    """

    private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}$")
}
