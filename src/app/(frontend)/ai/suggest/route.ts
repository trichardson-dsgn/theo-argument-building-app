type Kind = "ideas" | "evidence"

type Input = {
  kind: Kind
  level: "thesis" | "point"
  text: string
  outline: string
  depth: number
  feedback: string[] // author's notes for this point
  guidance: string[] // author's notes for every suggestion
  previous: string[] // last round's suggestions, to avoid repeats
  shape: string // computed summary of the outline's structure
}

const SYSTEM = `You are a sharp thinking partner for someone developing a talk or essay. The human writes; you suggest. Be specific, concrete and brief. Never write the talk for them.
Every suggestion has two voices:
- "title" and "detail" speak TO the author as advice (e.g. "Define what you mean by...", "Show a case where...").
- "statement" is the text as it would appear IN their outline: a declarative claim written in the author's voice, never an instruction or a question.
The author is building ONE argument toward ONE thesis, for a talk or post of limited length. The shape of a strong piece:
- one clear thesis;
- 3-5 key points (level 1) that each move the audience one step closer to believing it, in an order that builds;
- each key point earns its place with 1-2 vivid pieces of support (a story, example or striking fact);
- sub-points (level 2) only where the reasoning needs one more step; they rarely need their own evidence;
- almost nothing deeper than level 2. Depth is a cost: every extra layer is time the audience spends away from the thesis.
Your job is to help the argument converge, not expand. Favour sharpening, connecting, reordering, merging and cutting over adding. When the author is deep in the outline, pull them back up. Write for a general audience: vivid, concrete, conversational, never academic.`

const list = (v: unknown, n: number) =>
  Array.isArray(v) ? v.map((x) => String(x).slice(0, 500)).filter((x) => x.trim()).slice(-n) : []

function parseInput(body: unknown): Input | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  if (b.kind !== "ideas" && b.kind !== "evidence") return null
  if (typeof b.text !== "string" || !b.text.trim()) return null
  return {
    kind: b.kind,
    level: b.level === "thesis" ? "thesis" : "point",
    text: b.text.slice(0, 1500),
    outline: typeof b.outline === "string" ? b.outline.slice(0, 10000) : "",
    depth: Math.max(0, Math.min(6, Number(b.depth) || 0)),
    feedback: list(b.feedback, 12),
    guidance: list(b.guidance, 12),
    previous: list(b.previous, 15),
    shape: typeof b.shape === "string" ? b.shape.slice(0, 600) : "",
  }
}

const context = (i: Input) =>
  `The whole outline so far. Labels: THESIS, key points 1, 2, 3..., sub-points 1.1, 1.2... The point marked >>> is the one the author is working on:
${i.outline}

Shape of the argument: ${i.shape}

${i.level === "thesis" ? "Thesis" : "Focused point"}: ${i.text}

Use the whole outline: fit the focused point's role in the argument, build toward the thesis, connect with neighbouring points, and do not repeat what other points already cover.${
    i.guidance.length || i.feedback.length
      ? `

The author has given this feedback on earlier suggestions. Follow it closely; the most recent note matters most:
${[...i.guidance.map((g) => `- (for all points) ${g}`), ...i.feedback.map((f) => `- (for this point) ${f}`)].join("\n")}`
      : ""
  }${i.previous.length ? `\n\nAlready suggested last round (offer fresh options, do not repeat):\n${i.previous.map((p) => `- ${p}`).join("\n")}` : ""}`

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

const PERSPECTIVE = `- "bigPicture": step back from the focused point and judge the WHOLE argument against the shape of a strong piece. {"status": one of "just starting" | "taking shape" | "too deep" | "drifting" | "gaps" | "strong", "diagnosis": one direct sentence on where the argument as a whole stands, "nextMove": the single most valuable next step for the whole piece (which may be somewhere other than the focused point, e.g. "Give key point 3 a story" or "Fold 2.1.1 into 2.1"), "nextLabel": the label of the point that next step is about (e.g. "3", "2.1", "THESIS")}. Do not praise; be an editor. If the focused point is deeper than level 2, or the outline goes deeper than level 2, name that in the diagnosis and use "too deep" unless key points are missing support.`

async function ideas(key: string, i: Input) {
  const task =
    i.level === "thesis"
      ? `Suggest:
${PERSPECTIVE}
- "extend": 3 distinctly different ways this thesis could become a talk or post. Each has a "title" naming the angle, a one-sentence "detail", and 3-5 "children" key points in order. Each child is {"suggestion": advice to the author about what this point should do, "statement": the key point written as a declarative claim}. Account for any key points already written.
- "challenge": 2-3 ways a skeptic would push back, or where the thesis is vague, too broad or unearned. "title" is the challenge, "detail" why it matters, "statement" a key point that would answer it.`
      : i.depth === 1
        ? `This is a key point (one level below the thesis). Suggest:
${PERSPECTIVE}
- "extend": 2-3 ways to make this key point land harder for the thesis: a sharper wording, the single best reason behind it, or a bridge into the next key point. Each has a "title" (advice), a one-sentence "detail", a "statement" (how it would read in the outline), and "children": [].
- "challenge": 1 objection an audience member would actually raise, with "title", "detail" and a "statement" that answers it.`
        : `This point is already ${i.depth} levels below the thesis. Do NOT go deeper or open new sub-topics. Suggest:
${PERSPECTIVE} If this point is a tangent or too deep, say so and suggest folding it upward.
- "extend": 1-2 ways to tighten it or tie it back to its parent point and the thesis. Each has a "title" (advice), a one-sentence "detail", a "statement" (the tightened point), and "children": [].
- "challenge": [] unless the point actively undermines the argument.`
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
          content: `${context(i)}\n\n${task}\n\nReturn JSON: {"bigPicture":{"status","diagnosis","nextMove","nextLabel"},"extend":[{"title","detail","statement","children":[{"suggestion","statement"}]}],"challenge":[{"title","detail","statement"}]}`,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`OpenAI request failed (${res.status})`)
  const data = await res.json()
  const parsed = JSON.parse(data.choices[0].message.content)
  const map = (arr: unknown, type: "extend" | "challenge") =>
    (Array.isArray(arr) ? arr : []).slice(0, 4).map((o: Record<string, unknown>) => {
      const kids = (Array.isArray(o.children) ? o.children : []).slice(0, 6) as Record<string, unknown>[]
      return {
        type,
        title: str(o.title, 300),
        detail: str(o.detail),
        statement: str(o.statement || o.title, 400),
        children: kids.map((c) => str(c?.suggestion ?? c, 300)),
        childStatements: kids.map((c) => str(c?.statement ?? c?.suggestion ?? c, 400)),
        sourced: false,
      }
    })
  return {
    bigPicture: parsed.bigPicture
      ? {
          status: str(parsed.bigPicture.status, 30),
          diagnosis: str(parsed.bigPicture.diagnosis, 400),
          nextMove: str(parsed.bigPicture.nextMove, 300),
          nextLabel: str(parsed.bigPicture.nextLabel, 20),
        }
      : null,
    items: [...map(parsed.extend, "extend"), ...map(parsed.challenge, "challenge")],
  }
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

Search the web for ${i.level === "thesis" ? "2-3 real, specific opening hooks or" : i.depth === 1 ? "3 real, specific" : "1-2 real, quick"} things a speaker could use to make this ${i.level} land with a general audience: a story about a person or company, a well-known moment from history, sport, business or culture, a surprising fact, or a striking quote. Think of what makes a great talk or a widely shared article fun to consume, not a literature review. Avoid academic papers and jargon; if research matters, use one striking finding as reported by mainstream journalism. Pick things that fit this point's role and lead naturally into the next point.${i.depth >= 2 ? " This is a sub-point, so keep it light: one quick, clarifying example is enough." : ""} Only include items you actually found, each with its source URL. Never invent details or figures.

Reply with only JSON: {"items":[{"title":"short label","detail":"1-2 sentences to the author on why it is compelling and how to use it here","statement":"the story or fact as one vivid, conversational sentence for the outline, e.g. 'When Dr. Seuss was bet he could not write a book with only 50 words, he wrote Green Eggs and Ham.'","type":"story"|"example"|"surprising fact"|"quote","url":"source url","source":"publication or site name"}]}`,
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
  const items = (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 5).map((o: Record<string, unknown>) => {
    const url = str(o.url, 800)
    const valid = /^https?:\/\//.test(url)
    return {
      type: "evidence",
      title: str(o.title, 300),
      detail: str(o.detail),
      statement: str(o.statement || o.title, 500),
      evidenceType: str(o.type, 20),
      children: [],
      url: valid ? url.replace(/[?&]utm_source=openai/, "") : "",
      source: str(o.source, 120),
      // Sourced only when the URL was returned by the web search itself, not just written by the model.
      sourced: valid && cited.has(norm(url)),
    }
  })
  return { bigPicture: null, items }
}

export async function POST(request: Request) {
  const key = process.env.APP_OPENAI_API_KEY
  if (!key) return Response.json({ error: "Add APP_OPENAI_API_KEY in Make settings." }, { status: 400 })
  const input = parseInput(await request.json().catch(() => null))
  if (!input) return Response.json({ error: "Invalid request." }, { status: 400 })
  try {
    return Response.json(input.kind === "ideas" ? await ideas(key, input) : await evidence(key, input))
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Request failed" }, { status: 502 })
  }
}
