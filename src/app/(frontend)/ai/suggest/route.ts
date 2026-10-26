type Kind = "ideas" | "evidence"

type Input = {
  kind: Kind
  level: "thesis" | "point"
  text: string
  path: string[]
  children: string[]
}

const SYSTEM =
  "You are a sharp thinking partner for someone developing a talk or essay. The human writes; you suggest. Be specific, concrete and brief. Never write the talk for them."

function parseInput(body: unknown): Input | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  if (b.kind !== "ideas" && b.kind !== "evidence") return null
  if (typeof b.text !== "string" || !b.text.trim()) return null
  const list = (v: unknown, n: number) =>
    Array.isArray(v) ? v.map((x) => String(x).slice(0, 400)).slice(0, n) : []
  return {
    kind: b.kind,
    level: b.level === "thesis" ? "thesis" : "point",
    text: b.text.slice(0, 1500),
    path: list(b.path, 6),
    children: list(b.children, 12),
  }
}

function context(i: Input) {
  return [
    i.path.length ? `Thesis and parent points:\n${i.path.map((p, n) => `${"  ".repeat(n)}- ${p}`).join("\n")}` : "",
    `${i.level === "thesis" ? "Thesis" : "Focused point"}: ${i.text}`,
    i.children.length ? `Already written beneath it:\n${i.children.map((c) => `- ${c}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function extractJson(text: string) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("no json")
  return JSON.parse(text.slice(start, end + 1))
}

const str = (v: unknown, n = 500) => String(v ?? "").slice(0, n)
const norm = (u: string) => {
  try {
    const url = new URL(u)
    return (url.hostname.replace(/^www\./, "") + url.pathname).replace(/\/$/, "")
  } catch {
    return ""
  }
}

async function ideas(key: string, i: Input) {
  const task =
    i.level === "thesis"
      ? `Suggest:
- "extend": 3 distinctly different ways this thesis could become a talk or post. Each has a "title" naming the angle or structure, a one-sentence "detail", and 3-5 "children" key points in order.
- "challenge": 3 ways a skeptic would push back, or where the thesis is vague, too broad or unearned. "title" is the challenge, "detail" says why it matters.`
      : `Suggest:
- "extend": 3-4 ways to develop this point (sub-points, reasons, implications, or a sharper version). Each has a "title" (the sub-point as it would read in the outline), a one-sentence "detail", and "children": [].
- "challenge": 2-3 counterarguments, gaps or unclear claims in this point. "title" is the challenge, "detail" says why it matters.`
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      temperature: 0.8,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `${context(i)}\n\n${task}\n\nReturn JSON: {"extend":[{"title","detail","children":[]}],"challenge":[{"title","detail"}]}`,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status})`)
  const data = await res.json()
  const parsed = JSON.parse(data.choices[0].message.content)
  const map = (arr: unknown, type: "extend" | "challenge") =>
    (Array.isArray(arr) ? arr : []).slice(0, 4).map((o: Record<string, unknown>) => ({
      type,
      title: str(o.title, 300),
      detail: str(o.detail),
      children: Array.isArray(o.children) ? o.children.map((c) => str(c, 300)).slice(0, 6) : [],
      sourced: false,
    }))
  return [...map(parsed.extend, "extend"), ...map(parsed.challenge, "challenge")]
}

async function evidence(key: string, i: Input) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      instructions: SYSTEM,
      input: `${context(i)}

Search the web for 3-4 real, specific items a speaker could use to make this ${i.level} compelling: concrete examples, memorable anecdotes or stories, studies, or data. Prefer vivid and credible over generic. Only include items you actually found, each with its source URL. Never invent figures.

Reply with only JSON: {"items":[{"title":"short label","detail":"1-2 sentences on what it shows and how to use it","type":"example"|"anecdote"|"study"|"data","url":"source url","source":"publication or site name"}]}`,
    }),
  })
  if (!res.ok) throw new Error(`Web search failed (${res.status})`)
  const data = await res.json()
  let text = ""
  const cited = new Set<string>()
  for (const item of data.output ?? []) {
    if (item.type === "web_search_call") {
      for (const src of item.action?.sources ?? []) if (src.url) cited.add(norm(src.url))
    }
    if (item.type !== "message") continue
    for (const c of item.content ?? []) {
      if (c.type !== "output_text") continue
      text += c.text
      for (const a of c.annotations ?? []) if (a.type === "url_citation") cited.add(norm(a.url))
    }
  }
  const parsed = extractJson(text)
  return (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 5).map((o: Record<string, unknown>) => {
    const url = str(o.url, 800)
    const valid = /^https?:\/\//.test(url)
    return {
      type: "evidence",
      title: str(o.title, 300),
      detail: str(o.detail),
      evidenceType: str(o.type, 20),
      children: [],
      url: valid ? url.replace(/[?&]utm_source=openai/, "") : "",
      source: str(o.source, 120),
      // Sourced only when the URL was returned by the web search itself, not just written by the model.
      sourced: valid && cited.has(norm(url)),
    }
  })
}

export async function POST(request: Request) {
  const key = process.env.APP_OPENAI_API_KEY
  if (!key) return Response.json({ error: "Add APP_OPENAI_API_KEY in Make settings." }, { status: 400 })
  const input = parseInput(await request.json().catch(() => null))
  if (!input) return Response.json({ error: "Invalid request." }, { status: 400 })
  try {
    const items = input.kind === "ideas" ? await ideas(key, input) : await evidence(key, input)
    return Response.json({ items })
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 502 })
  }
}
