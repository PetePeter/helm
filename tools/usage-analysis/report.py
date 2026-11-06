"""Render agg.json (from analyse.py) as an HTML report.
Usage: python report.py agg.json report.html [findings.html]"""
import json, collections, sys, html
d = json.load(open(sys.argv[1]))
R = d['rows']
M = ('calls', 'fresh', 'cache', 'out', 'content', 'model_secs', 'tool_secs', 'items')


def group(keyf, rows=R, filt=lambda r: True):
    g = collections.defaultdict(collections.Counter)
    for r in rows:
        if filt(r) and r['type'] != 'hook_exec':
            g[keyf(r)].update({k: r.get(k, 0) for k in M})
    return g


def fmt(n):
    n = float(n)
    for u, s in ((1e9, 'B'), (1e6, 'M'), (1e3, 'k')):
        if abs(n) >= u: return '%.1f%s' % (n / u, s)
    return '%d' % n


def hrs(s): return '%.1fh' % (s / 3600) if s >= 3600 else '%dm' % (s / 60)


def table(title, g, heads, note='', limit=40, total=None):
    rows = sorted(g.items(), key=lambda x: -(x[1]['fresh'] + x[1]['out'] * 5))[:limit]
    tf = total or sum(v['fresh'] for v in g.values()) or 1
    h = ['<h2>%s</h2>' % title, '<p class=n>%s</p>' % note if note else '',
         '<table><tr>' + ''.join('<th>%s</th>' % x for x in heads) +
         '<th>calls</th><th>fresh in</th><th>% fresh</th><th>cache read</th><th>output</th><th>trigger size</th><th>model time</th><th>tool time</th></tr>']
    for k, v in rows:
        k = k if isinstance(k, tuple) else (k,)
        h.append('<tr>' + ''.join('<td>%s</td>' % html.escape(str(x)) for x in k) +
                 '<td>%s</td><td>%s</td><td>%.1f%%</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
                     fmt(v['calls']), fmt(v['fresh']), 100 * v['fresh'] / tf, fmt(v['cache']), fmt(v['out']),
                     fmt(v['content']), hrs(v['model_secs']), hrs(v['tool_secs'])))
    return '\n'.join(h) + '</table>'


body = []
body.append(table('1. By CLI · model · effort', group(lambda r: (r['cli'], r['model'], r['effort'])), ['cli', 'model', 'effort'],
                  'Claude transcripts do not record effort → unknown.'))
body.append(table('2. By trigger type (what fed the API call)', group(lambda r: (r['cli'], r['type'])), ['cli', 'trigger type']))
body.append(table('3. User-prompt origin', group(lambda r: (r['cli'], r['cat']), filt=lambda r: r['type'] in ('user_prompt', 'subagent_prompt')), ['cli', 'origin']))
body.append(table('4. Helm MCP tools', group(lambda r: (r['cli'], r['cat'].replace('mcp__helm__', '')), filt=lambda r: r['type'] == 'tool:mcp:helm'), ['cli', 'tool'], limit=50))
body.append(table('5. Built-in & other MCP tools', group(lambda r: (r['cli'], r['type'].replace('tool:', ''), r['cat']), filt=lambda r: r['type'].startswith('tool:') and r['type'] != 'tool:mcp:helm'), ['cli', 'group', 'tool'], limit=40))
body.append(table('6. Hook injections (context Helm adds)', group(lambda r: (r['cli'], r['cat']), filt=lambda r: r['type'] == 'hook_inject'), ['cli', 'hook'],
                  'Trigger size = estimated tokens Helm injected (chars/4). Shares the API call with whatever else arrived.'))
hx = collections.defaultdict(collections.Counter)
for r in R:
    if r['type'] == 'hook_exec': hx[(r['cli'], r['cat'])].update(runs=r.get('runs', 0), secs=r.get('secs', 0))
body.append('<h2>7. Hook execution time (Claude, wall-clock)</h2><table><tr><th>cli</th><th>hook</th><th>runs</th><th>total</th><th>avg</th></tr>' +
            ''.join('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%.0f ms</td></tr>' % (k[0], k[1], fmt(v['runs']), hrs(v['secs']), 1000 * v['secs'] / max(v['runs'], 1))
                    for k, v in sorted(hx.items(), key=lambda x: -x[1]['secs'])) + '</table>')

css = '''body{font:14px system-ui,sans-serif;margin:20px;color:#ddd;background:#1b1d22}h1{font-size:20px}h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{padding:4px 8px;border-bottom:1px solid #333;text-align:right}
th:first-child,td:first-child,th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:left}th{color:#9ab;background:#23262d}
.n{color:#999;font-size:12px}.box{background:#23262d;padding:10px 14px;border-left:3px solid #6a9fd4}code{color:#cda}'''
method = '''<div class=box><b>Method.</b> Source: %d Claude + %d Codex JSONL on disk (all dates). Each API call is attributed to the inputs that arrived since the previous call
(tool results, user prompts, hook injections); a call with several triggers splits its tokens evenly. <b>fresh in</b> = uncached input + cache writes (the real cost driver);
<b>cache read</b> = re-read context; <b>model time</b> = trigger→response (cap 15 min); <b>tool time</b> = tool call→result. Rows sorted by fresh + 5×output.
<b>continuation</b> = call with no new input (multi-step response).</div>''' % (d['files'].get('claude', 0), d['files'].get('codex', 0))
FIND = open(sys.argv[3], encoding='utf8').read() if len(sys.argv) > 3 else ''
open(sys.argv[2], 'w', encoding='utf8').write('<!doctype html><meta charset=utf-8><style>%s</style><h1>CLI usage — tokens &amp; time by trigger</h1>%s%s%s' % (css, method, FIND, '\n'.join(body)))
