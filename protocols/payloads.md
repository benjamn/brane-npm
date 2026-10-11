# Protocol: payloads

How to receive, analyze, and send file payloads (typically images) over
the LIVE loop. This is split out of the core [LIVE_loop](LIVE_loop.md)
protocol so the core stays lean; read this only when an event carries a
payload or you need to attach one.

Events may carry file payloads — typically images pasted or uploaded by
the operator. The `payloads` field is an array of relative file paths
(e.g., `["claude-abc/1709251200000_0.png"]`).

## Receiving payloads

When a `human_signal` or `agent_signal` event contains `payloads`,
the files are stored on disk at `~/.brane/payloads/{path}`. To read
a payload, construct the absolute path:

```
~/.brane/payloads/ + payloads[0]
```

Then read that absolute path with your harness's file-read tool —
most handle images natively (PNG, JPG, etc.).

## Image analysis delegation

Reading large images directly into your main context is expensive.
When possible, delegate to a sub-agent:

1. Spawn a sub-agent (Haiku or Sonnet) with the payload path and a
   specific question
2. The sub-agent reads the image via `Read` and narrates findings
   back as a foreign narration
3. You receive the analysis as an `agent_signal` event

If delegation produces insufficiently specific results, narrate to
the operator that you need to read the image directly, then proceed.

## Sending payloads

To attach files to your narrations, pass absolute file paths in the
`payloads` parameter of the `narrate` tool:

```json
{
  "say": "Here's a screenshot of the error",
  "after": 42,
  "payloads": ["/tmp/screenshot.png"]
}
```

The daemon copies files into managed storage. The operator sees them
rendered inline in the web UI.
