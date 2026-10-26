type Mode = "alternatives" | "support" | "prose"

const instructions: Record<Mode, string> = {
  alternatives:
    "Offer 3 meaningfully different ways the author COULD frame this point. Each option has a reworded point and a 2-4 bullet structure beneath it. Make the differences in argument or structure explicit.",
  support:
    "Offer 4 candidate supporting items for this point: a mix of sub-arguments, examples, and evidence to look for. Never invent statistics, quotes, or citations; describe evidence as something to verify or find.",
  prose:
    "Offer 2 short prose drafts (80-140 words) of this single point in different voices. Write only this point, not the whole talk.",
}

export async function POST(request: Request) {
  const key = process.env.APP_OPENAI_API_KEY
  if (!key) {
    return Response.json(
      { error: "Add APP_OPENAI_API_KEY in Make settings to enable AI exploration." },
      { status: 400 },
    )
  }
  const body = (await request.json().catch(() => null)) as {
    mode?: string
    path?: unknown
    node?: unknown
    children?: unknown
  } | null
  const mode = body?.mode as Mode
  if (!body || !(mode in instructions) || typeof body.node !== "string") {
    return Response.json({ error: "Invalid request." }, { status: 400 })
  }
  const path = Array.isArray(body.path) ? body.path.map(String).slice(0, 6) : []
  const children = Array.isArray(body.children) ? body.children.map(String).slice(0, 12) : []

  const prompt = [
    `Path from thesis to this point:\n${path.map((p, i) => `${"  ".repeat(i)}- ${p}`).join("\n")}`,
    `Selected point: ${body.node.slice(0, 1200)}`,
    children.length ? `Existing children:\n${children.map((c) => `- ${c}`).join("\n")}` : "",
    instructions[mode],
    'Return JSON: {"options":[{"title":string,"rationale":string (one sentence on what this option changes),"kind":"point"|"example"|"evidence","children":string[],"body":string}]}. Use empty arrays/strings for unused fields.',
  ].join("\n\n")

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content:
            "You help a speaker think through an argument. You propose options for one scoped part of an outline; the human decides. Be concise and concrete.",
        },
        { role: "user", content: prompt },
      ],
    }),
  })
  if (!res.ok) {
    return Response.json({ error: `OpenAI request failed (${res.status}).` }, { status: 502 })
  }
  const data = await res.json()
  try {
    const parsed = JSON.parse(data.choices[0].message.content)
    const options = (Array.isArray(parsed.options) ? parsed.options : []).slice(0, 4).map(
      (o: Record<string, unknown>) => ({
        title: String(o.title ?? "").slice(0, 400),
        rationale: String(o.rationale ?? "").slice(0, 400),
        kind: ["point", "example", "evidence"].includes(String(o.kind)) ? o.kind : "point",
        children: Array.isArray(o.children) ? o.children.map(String).slice(0, 6) : [],
        body: String(o.body ?? "").slice(0, 2000),
      }),
    )
    return Response.json({ options })
  } catch {
    return Response.json({ error: "Could not read AI response." }, { status: 502 })
  }
}
