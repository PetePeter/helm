"""Aggregate Claude Code + Codex on-disk JSONL transcripts into token/time rows per trigger.
Usage: python analyse.py out/agg.json   (write outside the repo)"""
import json, glob, os, collections, sys
from datetime import datetime

H = os.path.expanduser('~')
A = collections.defaultdict(collections.Counter)
FILES = collections.Counter()


def ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except Exception:
        return None


def est(x):
    return len(x if isinstance(x, str) else json.dumps(x)) // 4


def add(key, **m):
    for k, v in m.items():
        A[key][k] += v


def prompt_cat(t):
    t = t.lstrip()
    head = t[:300]
    if t.startswith('[HELM_MSG]') or 'inter_llm_message' in head:
        if '"mobile:' in head: return 'helm_msg:mobile'
        if '"desktop"' in head: return 'helm_msg:desktop'
        return 'helm_msg:session'
    if t.startswith('<task-notification'): return 'task_notification'
    if t.startswith('<command-name>') or t.startswith('/'): return 'slash_command'
    if 'Helm moved this conversation' in t or 'session_clear context' in t: return 'helm_clear/handover'
    if t.startswith('[HELM_'): return 'helm_injected'
    return 'typed_prompt'


def tool_group(n):
    return 'mcp:' + n.split('__')[1] if n.startswith('mcp__') else 'builtin'


def flush(cli, model, eff, pend, usage, t1, t0):
    fresh, cache, out, reas = usage
    mt = min(max(0, t1 - t0), 900) if t1 and t0 else 0
    tr = pend or [('continuation', '(no new input)', 0, None, 0)]
    n = len(tr)
    for ct, c, sz, _, dur in tr:
        add((cli, model, eff, ct, c), calls=1 / n, fresh=fresh / n, cache=cache / n, out=out / n,
            reasoning=reas / n, content=sz, model_secs=mt / n, tool_secs=min(dur, 3600), items=1)


def claude():
    for f in glob.glob(H + '/.claude/projects/**/*.jsonl', recursive=True):
        sub = 'subagents' in f
        FILES['claude'] += 1
        msgs, toolname, tuts, pend = {}, {}, {}, []
        last_t, model = None, 'unknown'
        try:
            lines = open(f, encoding='utf8').readlines()
        except Exception:
            continue
        for l in lines:
            try:
                d = json.loads(l)
            except Exception:
                continue
            t = d.get('type'); tt = ts(d.get('timestamp', ''))
            if t == 'attachment':
                a = d.get('attachment') or {}
                if a.get('type') == 'hook_additional_context':
                    pend.append(('hook_inject', 'hook:' + str(a.get('hookEvent')), est(a.get('content', '')), tt, 0))
                elif a.get('type') == 'hook_success' and a.get('durationMs'):
                    add(('claude', model, 'unknown', 'hook_exec', 'hook:' + str(a.get('hookEvent'))), runs=1, secs=a['durationMs'] / 1000)
                elif a.get('type') == 'queued_command':
                    p = str(a.get('prompt', ''))
                    pend.append(('user_prompt', prompt_cat(p), est(p), tt, 0))
            elif t == 'system' and d.get('subtype') == 'stop_hook_summary':
                for h in d.get('hookInfos', []):
                    add(('claude', model, 'unknown', 'hook_exec', 'hook:Stop'), runs=1, secs=h.get('durationMs', 0) / 1000)
            elif t == 'user' and not d.get('isMeta'):
                c = (d.get('message') or {}).get('content')
                kind = 'subagent_prompt' if sub else 'user_prompt'
                if isinstance(c, str):
                    pend.append((kind, prompt_cat(c), est(c), tt, 0))
                elif isinstance(c, list):
                    for b in c:
                        if b.get('type') == 'tool_result':
                            tid = b.get('tool_use_id'); n = toolname.get(tid, '?')
                            dur = tt - tuts[tid] if tt and tuts.get(tid) else 0
                            pend.append(('tool:' + tool_group(n), n, est(b.get('content', '')), tt, dur))
                        elif b.get('type') == 'text':
                            pend.append((kind, prompt_cat(b.get('text', '')), est(b.get('text', '')), tt, 0))
            elif t == 'assistant':
                m = d.get('message') or {}
                if m.get('model') == '<synthetic>':
                    continue
                model = m.get('model', model)
                for b in m.get('content') or []:
                    if b.get('type') == 'tool_use':
                        toolname[b['id']] = b['name']; tuts[b['id']] = tt
                mid = m.get('id')
                if mid not in msgs:
                    msgs[mid] = dict(trig=pend, t0=pend[-1][3] if pend else last_t, model=model)
                    pend = []
                msgs[mid]['u'] = m.get('usage') or {}; msgs[mid]['t1'] = tt; last_t = tt
        for x in msgs.values():
            u = x['u']
            usage = (u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0),
                     u.get('cache_read_input_tokens', 0), u.get('output_tokens', 0), 0)
            flush('claude', x['model'], 'unknown', x['trig'], usage, x.get('t1'), x.get('t0'))


def codex():
    for f in glob.glob(H + '/.codex/sessions/**/*.jsonl', recursive=True):
        FILES['codex'] += 1
        model, eff, pend, last_t = 'unknown', 'unknown', [], None
        for l in open(f, encoding='utf8'):
            try:
                d = json.loads(l)
            except Exception:
                continue
            p = d.get('payload') or {}; t = d.get('type'); tt = ts(d.get('timestamp', ''))
            pt = p.get('type')
            if t == 'turn_context':
                model = p.get('model', model)
                eff = ((p.get('collaboration_mode') or {}).get('settings') or {}).get('reasoning_effort') or p.get('effort') or eff
            elif t == 'event_msg' and pt == 'thread_settings_applied':
                s = p.get('thread_settings') or {}
                model = s.get('model', model); eff = s.get('reasoning_effort') or eff
            elif t == 'event_msg' and pt == 'item_completed':
                it = p.get('item') or {}; ty = it.get('type')
                dur = max(0, min(((p.get('completed_at_ms') or 0) - (p.get('started_at_ms') or 0)) / 1000, 3600))
                if ty == 'UserMessage':
                    txt = ' '.join(c.get('text', '') for c in it.get('content', []) if isinstance(c, dict))
                    pend.append(('user_prompt', prompt_cat(txt), est(txt), tt, 0))
                elif ty == 'HookPrompt':
                    txt = ' '.join(c.get('text', '') for c in it.get('fragments', []))
                    pend.append(('hook_inject', 'hook:Stop' if 'AIAGENT state' in txt else 'hook:other', est(txt), tt, 0))
                elif ty == 'CommandExecution':
                    pend.append(('tool:builtin', 'shell', est(it.get('aggregated_output') or ''), tt, dur))
                elif ty == 'McpToolCall':
                    pend.append(('tool:mcp:' + str(it.get('server')), 'mcp__%s__%s' % (it.get('server'), it.get('tool')), est(it.get('result') or ''), tt, dur))
                elif ty == 'FileChange':
                    pend.append(('tool:builtin', 'apply_patch', 0, tt, dur))
                elif ty == 'Extension':
                    pend.append(('tool:builtin', str(it.get('kind')), 0, tt, dur))
                elif ty == 'ImageView':
                    pend.append(('tool:builtin', 'view_image', 0, tt, dur))
                elif ty == 'ContextCompaction':
                    pend.append(('compaction', 'compaction', 0, tt, dur))
            elif t == 'response_item' and pt == 'message' and p.get('role') == 'developer':
                txt = ' '.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict))
                if 'HELM_' in txt:
                    pend.append(('hook_inject', 'hook:developer_ctx', est(txt), tt, 0))
            elif t == 'token_usage_record':
                u = p.get('usage') or {}
                inp, cr = u.get('input_tokens', 0), u.get('cached_input_tokens', 0)
                usage = (inp - cr, cr, u.get('output_tokens', 0), u.get('reasoning_output_tokens', 0))
                flush('codex', model, eff, pend, usage, tt, pend[-1][3] if pend else last_t)
                pend, last_t = [], tt


claude(); codex()
rows = [dict(cli=k[0], model=k[1], effort=k[2], type=k[3], cat=k[4], **{a: round(b, 2) for a, b in v.items()}) for k, v in A.items()]
json.dump(dict(rows=rows, files=dict(FILES)), open(sys.argv[1], 'w'))
print(len(rows), dict(FILES))
