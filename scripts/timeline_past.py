#!/usr/bin/env python3
"""把一个 Claude Code session 读成工作日志。

节点 = 你发的每一条消息；每段列出那之后实际发生的变化。
v0 不调模型：只用 jsonl 里确定性的信号。

用法: worklog.py <session.jsonl> [--since 2026-08-24] [--min-tools 1]
"""
import json
import re
import sys
from collections import Counter

WRITES = {"Write", "Edit", "NotebookEdit", "MultiEdit"}
READS = {"Read", "Glob", "Grep", "ToolSearch"}
WEB = {"WebSearch", "WebFetch"}


def blocks(d, kind):
    c = (d.get("message") or {}).get("content")
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == kind:
                yield b


def text_of(d):
    c = (d.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    return " ".join(b.get("text", "") for b in blocks(d, "text"))


def head(s, n=70):
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = " ".join(s.split())
    return s[:n] + ("…" if len(s) > n else "")


# 真正干活的那个词：跳过 cd/export/source 这些铺垫，以及 timeout/nohup 这些前缀。
NOISE = {"cd", "export", "source", "set", "unset", "echo"}
PREFIX = {"timeout", "nohup", "sudo", "env", "time", "nice", "xargs", "command"}


def verb_of(cmd):
    for part in re.split(r"&&|\|\||;", cmd):
        words = part.strip().split()
        while words and (words[0] in PREFIX or "=" in words[0] or words[0].isdigit()):
            words.pop(0)
        if words and words[0] not in NOISE:
            v = words[0].split("/")[-1]
            # `python train.py` 比单独一个 `python` 有用得多
            if v in {"python", "python3", "uv", "npm", "npx", "git", "bash", "sh"} and len(words) > 1:
                return f"{v} {words[1].split('/')[-1]}"
            return v
    return None


def segments(path):
    """切成 [(发起消息, [这段里的事件])]。"""
    seg = None
    for line in open(path):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        t = d.get("type")

        if t == "user" and not d.get("isMeta"):
            if (d.get("origin") or {}).get("kind") == "human":
                if seg:
                    yield seg
                seg = (d, [])
                continue
            # 工具结果：找出报错的
            for b in blocks(d, "tool_result"):
                if seg and b.get("is_error"):
                    seg[1].append(("error", head(str(b.get("content")), 90)))

        if t == "assistant" and seg:
            for b in blocks(d, "tool_use"):
                seg[1].append(("tool", b.get("name"), b.get("input") or {}))

    if seg:
        yield seg


def render(prompt, events):
    files, cmds, kinds, errs = [], [], Counter(), []
    for ev in events:
        if ev[0] == "error":
            errs.append(ev[1])
            continue
        name, inp = ev[1], ev[2]
        kinds[name] += 1
        if name in WRITES:
            f = inp.get("file_path") or inp.get("notebook_path") or ""
            if f and f not in files:
                files.append(f)
        elif name == "Bash":
            cmds.append(inp.get("command", ""))

    out = [f"### {prompt['timestamp'][:16].replace('T', ' ')}  {head(text_of(prompt))}"]
    if files:
        out.append(f"  改动 {len(files)} 个文件: " + ", ".join(f.split("/")[-1] for f in files[:6])
                   + (" …" if len(files) > 6 else ""))
    if cmds:
        verbs = Counter(filter(None, (verb_of(c) for c in cmds)))
        out.append(f"  跑了 {len(cmds)} 条命令: " + ", ".join(f"{v}×{n}" for v, n in verbs.most_common(5)))
    busy = [f"{k}×{v}" for k, v in kinds.most_common() if k not in WRITES and k != "Bash"]
    if busy:
        out.append("  其他: " + ", ".join(busy[:6]))
    for e in errs[:3]:
        out.append(f"  ⚠ {e}")
    if len(errs) > 3:
        out.append(f"  ⚠ …另有 {len(errs) - 3} 个报错")
    if len(out) == 1:
        out.append("  (只是对话，没动任何东西)")
    return "\n".join(out)


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    path = args[0]
    since = next((a.split("=", 1)[1] for a in args if a.startswith("--since=")), None)
    min_tools = int(next((a.split("=", 1)[1] for a in args if a.startswith("--min-tools=")), 0))

    n = 0
    for prompt, events in segments(path):
        if since and prompt["timestamp"][:10] < since:
            continue
        if len([e for e in events if e[0] == "tool"]) < min_tools:
            continue
        print(render(prompt, events))
        print()
        n += 1
    print(f"— {n} 段 —", file=sys.stderr)


if __name__ == "__main__":
    main()
