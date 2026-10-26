"use client"

import { useEffect, useMemo, useState } from "react"

type Kind = "thesis" | "point" | "example" | "evidence"
type Node = {
  id: string
  text: string
  kind: Kind
  body: string
  source: string // human-entered citation; marks the node as sourced
  origin: "human" | "ai"
  children: Node[]
}
type Mode = "alternatives" | "support" | "prose"
type Option = {
  id: string
  title: string
  rationale: string
  kind: Kind
  children: string[]
  body: string
  status: "open" | "promoted" | "displaced"
}
type Exploration = { id: string; nodeId: string; nodeText: string; mode: Mode; at: number; options: Option[] }
type Version = { id: string; label: string; at: number; outline: Node }
type State = { outline: Node; explorations: Exploration[]; versions: Version[] }

const uid = () => Math.random().toString(36).slice(2, 10)
const mk = (text: string, kind: Kind = "point", children: Node[] = [], origin: Node["origin"] = "human"): Node => ({
  id: uid(), text, kind, body: "", source: "", origin, children,
})
const STORAGE = "talk-workspace-v1"

const initial = (): State => ({
  outline: mk("Working thesis: what should the audience believe or do afterwards?", "thesis", [
    mk("Opening: the problem as the audience feels it"),
    mk("Core argument"),
    mk("Close: what changes if they accept this"),
  ]),
  explorations: [],
  versions: [],
})

const ALTITUDES = [
  { id: "thesis", label: "Thesis", depth: 0, body: false, hint: "The one claim" },
  { id: "structure", label: "Structure", depth: 1, body: false, hint: "Main movements" },
  { id: "arguments", label: "Arguments", depth: 2, body: false, hint: "Supporting points" },
  { id: "evidence", label: "Evidence", depth: 99, body: false, hint: "Examples and sources" },
  { id: "full", label: "Full draft", depth: 99, body: true, hint: "Prose for each point" },
] as const

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "alternatives", label: "Alternative framings", hint: "3 ways this point could be argued and structured" },
  { id: "support", label: "Support candidates", hint: "Sub-points, examples, evidence to look for" },
  { id: "prose", label: "Draft prose", hint: "2 body drafts for this point only" },
]

function find(n: Node, id: string, path: Node[] = []): { node: Node; path: Node[] } | null {
  if (n.id === id) return { node: n, path: [...path, n] }
  for (const c of n.children) {
    const r = find(c, id, [...path, n])
    if (r) return r
  }
  return null
}
function update(n: Node, id: string, fn: (n: Node) => Node): Node {
  if (n.id === id) return fn(n)
  return { ...n, children: n.children.map((c) => update(c, id, fn)) }
}
function removeNode(n: Node, id: string): Node {
  return { ...n, children: n.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)) }
}
function parentOf(n: Node, id: string): Node | null {
  if (n.children.some((c) => c.id === id)) return n
  for (const c of n.children) {
    const r = parentOf(c, id)
    if (r) return r
  }
  return null
}
function count(n: Node): number {
  return 1 + n.children.reduce((s, c) => s + count(c), 0)
}

export default function Workspace() {
  const [state, setState] = useState<State | null>(null)
  const [altitude, setAltitude] = useState<(typeof ALTITUDES)[number]["id"]>("arguments")
  const [selected, setSelected] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Version | null>(null)
  const [loading, setLoading] = useState<Mode | null>(null)
  const [error, setError] = useState("")
  const [tab, setTab] = useState<"explore" | "versions">("explore")

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE)
      setState(saved ? JSON.parse(saved) : initial())
    } catch {
      setState(initial())
    }
  }, [])
  useEffect(() => {
    if (state) localStorage.setItem(STORAGE, JSON.stringify(state))
  }, [state])

  const alt = ALTITUDES.find((a) => a.id === altitude)!
  const outline = viewing?.outline ?? state?.outline
  const sel = state && selected ? find(state.outline, selected) : null
  const nodeExplorations = useMemo(
    () => (state && selected ? state.explorations.filter((e) => e.nodeId === selected).sort((a, b) => b.at - a.at) : []),
    [state, selected],
  )
  if (!state || !outline) return <div className="p-10 text-sm text-stone-500">Loading workspace...</div>

  const setOutline = (fn: (o: Node) => Node) => setState((s) => (s ? { ...s, outline: fn(s.outline) } : s))
  const edit = (id: string, patch: Partial<Node>) => setOutline((o) => update(o, id, (n) => ({ ...n, ...patch })))
  const addChild = (id: string) => {
    const child = mk("")
    setOutline((o) => update(o, id, (n) => ({ ...n, children: [...n.children, child] })))
    setSelected(child.id)
  }
  const addSibling = (id: string) => {
    const p = parentOf(state.outline, id)
    if (!p) return addChild(id)
    const sib = mk("")
    setOutline((o) =>
      update(o, p.id, (n) => {
        const i = n.children.findIndex((c) => c.id === id)
        const children = [...n.children]
        children.splice(i + 1, 0, sib)
        return { ...n, children }
      }),
    )
    setSelected(sib.id)
  }

  async function explore(mode: Mode) {
    if (!sel) return
    setLoading(mode)
    setError("")
    try {
      const res = await fetch("/ai/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          path: sel.path.slice(0, -1).map((n) => n.text),
          node: sel.node.text + (sel.node.body ? `\n\nCurrent body: ${sel.node.body}` : ""),
          children: sel.node.children.map((c) => c.text),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Request failed")
      const exp: Exploration = {
        id: uid(),
        nodeId: sel.node.id,
        nodeText: sel.node.text,
        mode,
        at: Date.now(),
        options: data.options.map((o: Omit<Option, "id" | "status">) => ({ ...o, id: uid(), status: "open" })),
      }
      setState((s) => (s ? { ...s, explorations: [exp, ...s.explorations] } : s))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed")
    } finally {
      setLoading(null)
    }
  }

  function promote(exp: Exploration, opt: Option) {
    setState((s) => {
      if (!s) return s
      const target = find(s.outline, exp.nodeId)
      if (!target) return s
      let outline = s.outline
      const extra: Option[] = []
      if (exp.mode === "alternatives") {
        // Keep what was in the outline as a navigable alternative before replacing it.
        extra.push({
          id: uid(), title: target.node.text, rationale: "Previously in the outline", kind: target.node.kind,
          children: target.node.children.map((c) => c.text), body: target.node.body, status: "displaced",
        })
        outline = update(outline, exp.nodeId, (n) => ({
          ...n, text: opt.title, origin: "ai", children: opt.children.map((t) => mk(t, "point", [], "ai")),
        }))
      } else if (exp.mode === "support") {
        outline = update(outline, exp.nodeId, (n) => ({
          ...n, children: [...n.children, mk(opt.title, opt.kind === "thesis" ? "point" : opt.kind, [], "ai")],
        }))
      } else {
        if (target.node.body.trim()) {
          extra.push({ id: uid(), title: "Previous body", rationale: "Previously in the outline", kind: "point", children: [], body: target.node.body, status: "displaced" })
        }
        outline = update(outline, exp.nodeId, (n) => ({ ...n, body: opt.body || opt.title }))
      }
      return {
        ...s,
        outline,
        explorations: s.explorations.map((e) =>
          e.id === exp.id
            ? { ...e, options: [...e.options.map((o) => (o.id === opt.id ? { ...o, status: "promoted" as const } : o)), ...extra] }
            : e,
        ),
      }
    })
    if (exp.mode === "prose") setAltitude("full")
  }

  function commitVersion() {
    const label = prompt("Name this version", `Version ${state!.versions.length + 1}`)
    if (!label) return
    setState((s) => (s ? { ...s, versions: [{ id: uid(), label, at: Date.now(), outline: structuredClone(s.outline) }, ...s.versions] } : s))
  }

  const renderNode = (n: Node, depth: number, readOnly: boolean): React.ReactNode => {
    if (depth > alt.depth) return null
    const isSel = selected === n.id && !readOnly
    const hidden = n.children.length > 0 && depth === alt.depth
    const exps = state.explorations.filter((e) => e.nodeId === n.id)
    const openAlts = exps.reduce((s, e) => s + e.options.filter((o) => o.status !== "promoted").length, 0)
    return (
      <li key={n.id} className="relative">
        <div
          onClick={() => !readOnly && setSelected(n.id)}
          className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 transition ${isSel ? "bg-amber-50 ring-1 ring-amber-300" : readOnly ? "" : "hover:bg-stone-100"}`}
        >
          <span className={`mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full ${n.kind === "thesis" ? "bg-stone-900" : n.kind === "evidence" ? "bg-sky-600" : n.kind === "example" ? "bg-emerald-600" : "bg-stone-400"}`} />
          <div className="min-w-0 flex-1">
            {readOnly ? (
              <p className={depth === 0 ? "font-serif text-xl" : "text-[15px]"}>{n.text || <em className="text-stone-400">Empty</em>}</p>
            ) : (
              <textarea
                value={n.text}
                rows={1}
                placeholder={depth === 0 ? "State your thesis" : "Write a point"}
                onChange={(e) => edit(n.id, { text: e.target.value, origin: "human" })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    if (depth === 0) addChild(n.id)
                    else addSibling(n.id)
                  }
                  if (e.key === "Tab") {
                    e.preventDefault()
                    addChild(n.id)
                  }
                }}
                className={`field-sizing-content w-full resize-none bg-transparent outline-none ${depth === 0 ? "font-serif text-xl leading-snug" : "text-[15px] leading-relaxed"}`}
              />
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {n.kind !== "thesis" && n.kind !== "point" && <Tag tone={n.kind === "evidence" ? "sky" : "emerald"}>{n.kind}</Tag>}
              {n.source ? <Tag tone="sky">Sourced: {n.source}</Tag> : n.origin === "ai" ? <Tag tone="amber">AI suggestion, unverified</Tag> : null}
              {openAlts > 0 && <Tag tone="stone">{openAlts} alternatives kept</Tag>}
              {hidden && <Tag tone="stone">+{count(n) - 1} below</Tag>}
            </div>
            {alt.body && n.body && (
              readOnly ? <p className="mt-2 whitespace-pre-wrap font-serif text-[15px] leading-7 text-stone-700">{n.body}</p> : (
                <textarea value={n.body} placeholder="Write the body for this point" onChange={(e) => edit(n.id, { body: e.target.value })} className="field-sizing-content mt-2 w-full resize-none border-l-2 border-stone-300 bg-transparent pl-3 font-serif text-[15px] leading-7 text-stone-700 outline-none" />
              )
            )}
          </div>
        </div>
        {n.children.length > 0 && depth < alt.depth && (
          <ul className="ml-4 border-l border-stone-200 pl-3">{n.children.map((c) => renderNode(c, depth + 1, readOnly))}</ul>
        )}
      </li>
    )
  }

  return (
    <div className="flex h-screen bg-[#f7f5f0] text-stone-900">
      <aside className="flex w-56 shrink-0 flex-col border-r border-stone-200 p-4">
        <p className="font-serif text-lg">Talkshop</p>
        <p className="mb-6 text-xs text-stone-500">One outline, many altitudes</p>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-stone-500">Altitude</p>
        <div className="space-y-0.5">
          {ALTITUDES.map((a, i) => (
            <button key={a.id} onClick={() => setAltitude(a.id)} className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm ${altitude === a.id ? "bg-stone-900 text-white" : "hover:bg-stone-200"}`}>
              <span className="w-3 text-xs opacity-60">{i + 1}</span>
              <span>{a.label}<span className="block text-[11px] opacity-60">{a.hint}</span></span>
            </button>
          ))}
        </div>
        <div className="mt-auto space-y-2 text-[11px] text-stone-500">
          <p className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-amber-400" />AI suggestion, unverified</p>
          <p className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-sky-600" />Sourced by you</p>
          <p className="pt-2">Enter: new point. Tab: add child.</p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-200 bg-[#f7f5f0]/90 px-10 py-3 backdrop-blur">
          <div className="text-sm">
            {viewing ? (
              <span>Viewing committed version <b>{viewing.label}</b> (read only)</span>
            ) : (
              <span className="text-stone-500">Living outline · {alt.label} view · {count(state.outline)} points</span>
            )}
          </div>
          <div className="flex gap-2">
            {viewing ? (
              <>
                <Btn onClick={() => setViewing(null)}>Back to living outline</Btn>
                <Btn primary onClick={() => { if (confirm("Replace the living outline with this version? Commit first if you want to keep the current one.")) { setOutline(() => structuredClone(viewing.outline)); setViewing(null) } }}>Restore this version</Btn>
              </>
            ) : (
              <Btn primary onClick={commitVersion}>Commit version</Btn>
            )}
          </div>
        </div>
        <ul className="mx-auto max-w-3xl px-10 py-10">{renderNode(outline, 0, !!viewing)}</ul>
      </main>

      <aside className="flex w-[400px] shrink-0 flex-col border-l border-stone-200 bg-white">
        <div className="flex border-b border-stone-200 text-sm">
          {(["explore", "versions"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 py-3 ${tab === t ? "border-b-2 border-stone-900 font-medium" : "text-stone-500"}`}>
              {t === "explore" ? "Alternatives" : `Versions (${state.versions.length})`}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "versions" ? (
            <div className="space-y-2">
              <p className="text-xs text-stone-500">Committed snapshots of the whole outline. Alternatives are kept separately per point.</p>
              {state.versions.length === 0 && <Empty>No versions yet. Commit one when the outline reaches a state worth keeping.</Empty>}
              {state.versions.map((v) => (
                <button key={v.id} onClick={() => setViewing(v)} className={`block w-full rounded-lg border p-3 text-left ${viewing?.id === v.id ? "border-stone-900" : "border-stone-200 hover:border-stone-400"}`}>
                  <p className="text-sm font-medium">{v.label}</p>
                  <p className="text-xs text-stone-500">{new Date(v.at).toLocaleString()} · {count(v.outline)} points</p>
                  <p className="mt-1 line-clamp-2 font-serif text-sm text-stone-600">{v.outline.text}</p>
                </button>
              ))}
            </div>
          ) : !sel || viewing ? (
            <Empty>{viewing ? "Return to the living outline to explore." : "Select a point in the outline to explore alternatives for it. AI only works on the point you select."}</Empty>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">Selected point</p>
                <p className="font-serif text-[15px]">{sel.node.text || "Empty point"}</p>
                <div className="flex items-center gap-2 text-xs">
                  <select value={sel.node.kind} onChange={(e) => edit(sel.node.id, { kind: e.target.value as Kind })} className="rounded border border-stone-200 px-1 py-0.5">
                    {(["thesis", "point", "example", "evidence"] as Kind[]).map((k) => <option key={k}>{k}</option>)}
                  </select>
                  <input value={sel.node.source} onChange={(e) => edit(sel.node.id, { source: e.target.value })} placeholder="Add source (URL or citation)" className="flex-1 rounded border border-stone-200 px-2 py-0.5" />
                </div>
                <div className="flex gap-3 text-xs text-stone-500">
                  <button onClick={() => addChild(sel.node.id)} className="hover:text-stone-900">+ Child</button>
                  {sel.path.length > 1 && <button onClick={() => addSibling(sel.node.id)} className="hover:text-stone-900">+ Sibling</button>}
                  {!sel.node.body && <button onClick={() => { edit(sel.node.id, { body: " " }); setAltitude("full") }} className="hover:text-stone-900">+ Body</button>}
                  {sel.path.length > 1 && <button onClick={() => { setOutline((o) => removeNode(o, sel.node.id)); setSelected(null) }} className="ml-auto hover:text-red-700">Delete</button>}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">Explore this point</p>
                {MODES.map((m) => (
                  <button key={m.id} disabled={!!loading || !sel.node.text.trim()} onClick={() => explore(m.id)} className="block w-full rounded-lg border border-stone-200 px-3 py-2 text-left text-sm hover:border-stone-900 disabled:opacity-50">
                    {loading === m.id ? "Exploring..." : m.label}
                    <span className="block text-xs text-stone-500">{m.hint}</span>
                  </button>
                ))}
                {error && <p className="text-xs text-red-700">{error}</p>}
              </div>

              {nodeExplorations.length === 0 && <Empty>No alternatives for this point yet.</Empty>}
              {nodeExplorations.map((exp) => (
                <section key={exp.id} className="space-y-2">
                  <p className="text-[11px] text-stone-500">
                    {MODES.find((m) => m.id === exp.mode)?.label} · {new Date(exp.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {exp.nodeText !== sel.node.text && <span> · asked of an earlier wording</span>}
                  </p>
                  {exp.options.map((o, i) => (
                    <div key={o.id} className={`rounded-lg border p-3 ${o.status === "promoted" ? "border-emerald-300 bg-emerald-50/50" : o.status === "displaced" ? "border-dashed border-stone-300" : "border-stone-200"}`}>
                      <div className="mb-1 flex items-center gap-1.5 text-[11px]">
                        <span className="text-stone-400">{o.status === "displaced" ? "Kept" : `Option ${String.fromCharCode(65 + i)}`}</span>
                        {exp.mode === "support" && <Tag tone={o.kind === "evidence" ? "sky" : o.kind === "example" ? "emerald" : "stone"}>{o.kind}</Tag>}
                        {o.status !== "displaced" && <Tag tone="amber">unverified</Tag>}
                      </div>
                      {exp.mode !== "prose" && <p className="text-sm font-medium">{o.title}</p>}
                      {o.children.length > 0 && <ul className="mt-1 list-disc pl-4 text-sm text-stone-700">{o.children.map((c, j) => <li key={j}>{c}</li>)}</ul>}
                      {exp.mode === "prose" && o.body && <p className="whitespace-pre-wrap font-serif text-sm leading-6 text-stone-700">{o.body}</p>}
                      <p className="mt-1 text-xs italic text-stone-500">{o.rationale}</p>
                      <div className="mt-2 flex justify-end">
                        {o.status === "promoted" && exp.mode !== "support" ? (
                          <span className="text-xs text-emerald-700">In outline</span>
                        ) : (
                          <button onClick={() => promote(exp, o)} className="rounded-md bg-stone-900 px-2.5 py-1 text-xs text-white hover:bg-stone-700">
                            {o.status === "promoted" ? "Promote again" : exp.mode === "alternatives" ? "Promote: replace point" : exp.mode === "support" ? "Promote: add as child" : "Promote: use as body"}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone: "sky" | "emerald" | "amber" | "stone" }) {
  const c = { sky: "bg-sky-50 text-sky-800", emerald: "bg-emerald-50 text-emerald-800", amber: "bg-amber-50 text-amber-800", stone: "bg-stone-100 text-stone-600" }[tone]
  return <span className={`max-w-[260px] truncate rounded px-1.5 py-0.5 ${c}`}>{children}</span>
}
function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return <button onClick={onClick} className={`rounded-md px-3 py-1.5 text-sm ${primary ? "bg-stone-900 text-white hover:bg-stone-700" : "border border-stone-300 hover:bg-stone-100"}`}>{children}</button>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-stone-300 p-4 text-sm text-stone-500">{children}</p>
}
