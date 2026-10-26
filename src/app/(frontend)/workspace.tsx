"use client"

import { useEffect, useRef, useState } from "react"

type Kind = "thesis" | "point" | "evidence"
type Node = {
  id: string
  text: string
  kind: Kind
  body: string
  source: string // URL; only set from a web-search citation or by the writer
  origin: "human" | "ai"
  children: Node[]
}
type SuggestionType = "extend" | "challenge" | "evidence"
type Suggestion = {
  id: string
  type: SuggestionType
  title: string // written to the author, shown in the panel
  detail: string
  statement: string // written as a claim, inserted into the outline
  children: string[]
  childStatements?: string[]
  url?: string
  source?: string
  evidenceType?: string
  sourced: boolean
  status: "new" | "added" | "dismissed"
  addedChildren?: number[]
}
type Batch = { id: string; nodeId: string; text: string; at: number; items: Suggestion[]; perspective?: string; errors: Partial<Record<"ideas" | "evidence", string>> }
type Version = { id: string; label: string; at: number; outline: Node }
type State = { outline: Node; batches: Batch[]; versions: Version[] }

const uid = () => Math.random().toString(36).slice(2, 10)
const mk = (text: string, kind: Kind = "point", origin: Node["origin"] = "human", source = ""): Node => ({
  id: uid(), text, kind, body: "", source, origin, children: [],
})
const STORAGE = "talk-workspace-v2"
const IDLE_MS = 2500
const MIN_CHARS = 12

const ALTITUDES = [
  { id: "thesis", label: "Thesis", depth: 0, body: false, hint: "The one claim" },
  { id: "points", label: "Key points", depth: 1, body: false, hint: "The structure" },
  { id: "support", label: "Support", depth: 99, body: false, hint: "Arguments and evidence" },
  { id: "draft", label: "Full draft", depth: 99, body: true, hint: "Prose under each point" },
] as const

function find(n: Node, id: string, path: Node[] = []): { node: Node; path: Node[] } | null {
  if (n.id === id) return { node: n, path: [...path, n] }
  for (const c of n.children) {
    const r = find(c, id, [...path, n])
    if (r) return r
  }
  return null
}
const update = (n: Node, id: string, fn: (n: Node) => Node): Node =>
  n.id === id ? fn(n) : { ...n, children: n.children.map((c) => update(c, id, fn)) }
const removeNode = (n: Node, id: string): Node => ({ ...n, children: n.children.filter((c) => c.id !== id).map((c) => removeNode(c, id)) })
function parentOf(n: Node, id: string): Node | null {
  if (n.children.some((c) => c.id === id)) return n
  for (const c of n.children) {
    const r = parentOf(c, id)
    if (r) return r
  }
  return null
}
const count = (n: Node): number => 1 + n.children.reduce((s, c) => s + count(c), 0)
const hasEvidence = (n: Node): boolean => n.kind === "evidence" || !!n.source || n.children.some(hasEvidence)
// Whole outline as indented text, with the focused point marked, so suggestions fit the full argument.
const serialize = (n: Node, focusId: string, depth = 0): string =>
  [
    `${"  ".repeat(depth)}${n.id === focusId ? ">>> " : "- "}${depth === 0 ? "THESIS: " : n.kind === "evidence" ? "[evidence] " : ""}${n.text.trim() || "(empty)"}`,
    ...n.children.filter((c) => c.text.trim()).map((c) => serialize(c, focusId, depth + 1)),
  ].join("\n")
// Flattened visible order, used for moving focus on Backspace.
const flatten = (n: Node): Node[] => [n, ...n.children.flatMap(flatten)]

export default function Workspace() {
  const [state, setState] = useState<State | null>(null)
  const [altitude, setAltitude] = useState<(typeof ALTITUDES)[number]["id"]>("support")
  const [selected, setSelected] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Version | null>(null)
  const [pending, setPending] = useState<Record<string, { ideas?: boolean; evidence?: boolean }>>({})
  const [tab, setTab] = useState<"suggest" | "versions">("suggest")
  const [showEarlier, setShowEarlier] = useState(false)
  const focusNext = useRef<string | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE)
      const s: State = saved ? JSON.parse(saved) : { outline: mk("", "thesis"), batches: [], versions: [] }
      setState(s)
      if (!s.outline.text) focusNext.current = s.outline.id
    } catch {
      setState({ outline: mk("", "thesis"), batches: [], versions: [] })
    }
  }, [])
  useEffect(() => {
    if (state) localStorage.setItem(STORAGE, JSON.stringify(state))
  }, [state])

  const sel = state && selected ? find(state.outline, selected) : null
  const selText = sel?.node.text ?? ""

  // Suggest automatically once the writer pauses on a point they have changed.
  useEffect(() => {
    if (!state || !sel || viewing) return
    const text = sel.node.text.trim()
    if (text.length < MIN_CHARS || sel.node.kind === "evidence") return
    const last = state.batches.find((b) => b.nodeId === sel.node.id)
    if (last && last.text === text) return
    const t = setTimeout(() => suggest(sel.node.id), IDLE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, selText, viewing])

  if (!state) return <div className="p-10 text-sm text-stone-500">Loading workspace...</div>
  const alt = ALTITUDES.find((a) => a.id === altitude)!
  const outline = viewing?.outline ?? state.outline

  const setOutline = (fn: (o: Node) => Node) => setState((s) => (s ? { ...s, outline: fn(s.outline) } : s))
  const edit = (id: string, patch: Partial<Node>) => setOutline((o) => update(o, id, (n) => ({ ...n, ...patch })))
  const focus = (id: string) => {
    focusNext.current = id
    setSelected(id)
  }

  function addSiblingAfter(id: string) {
    const p = parentOf(state!.outline, id)
    const node = mk("")
    if (!p) setOutline((o) => ({ ...o, children: [node, ...o.children] }))
    else
      setOutline((o) =>
        update(o, p.id, (n) => {
          const children = [...n.children]
          children.splice(children.findIndex((c) => c.id === id) + 1, 0, node)
          return { ...n, children }
        }),
      )
    focus(node.id)
  }
  function indent(id: string) {
    const p = parentOf(state!.outline, id)
    if (!p) return
    const i = p.children.findIndex((c) => c.id === id)
    if (i < 1) return
    const prev = p.children[i - 1]
    const node = p.children[i]
    setOutline((o) => update(removeNode(o, id), prev.id, (n) => ({ ...n, children: [...n.children, node] })))
    focus(id)
  }
  function outdent(id: string) {
    const p = parentOf(state!.outline, id)
    const g = p && parentOf(state!.outline, p.id)
    if (!p || !g) return
    const node = find(state!.outline, id)!.node
    setOutline((o) =>
      update(removeNode(o, id), g.id, (n) => {
        const children = [...n.children]
        children.splice(children.findIndex((c) => c.id === p.id) + 1, 0, node)
        return { ...n, children }
      }),
    )
    focus(id)
  }
  function removeEmpty(id: string) {
    const order = flatten(state!.outline)
    const i = order.findIndex((n) => n.id === id)
    if (i < 1) return
    setOutline((o) => removeNode(o, id))
    focus(order[i - 1].id)
  }
  const addChildren = (parentId: string, nodes: Node[]) =>
    setOutline((o) => update(o, parentId, (n) => ({ ...n, children: [...n.children, ...nodes] })))

  // The thesis gets structure and challenges; points below it also get web evidence.
  async function suggest(nodeId: string, only?: ("ideas" | "evidence")[]) {
    const target = find(state!.outline, nodeId)
    if (!target || pendingRef.current[nodeId]) return
    const depth = target.path.length - 1
    // Thesis: structure. Key points and their sub-points: ideas plus evidence. Deeper: tighten only.
    const kinds = only ?? (depth === 0 || depth >= 3 ? (["ideas"] as const) : (["ideas", "evidence"] as const))
    const text = target.node.text.trim()
    // A targeted request (e.g. evidence for the thesis) joins the current round instead of starting a new one.
    const current = state!.batches.find((b) => b.nodeId === nodeId)
    const reuse = only && current && current.text === text
    const batch: Batch = reuse ? current : { id: uid(), nodeId, text, at: Date.now(), items: [], errors: {} }
    if (!reuse) setState((s) => (s ? { ...s, batches: [batch, ...s.batches] } : s))
    setPending((p) => ({ ...p, [nodeId]: Object.fromEntries(kinds.map((k) => [k, true])) }))
    setShowEarlier(false)
    const payload = {
      level: target.path.length === 1 ? "thesis" : "point",
      text,
      outline: serialize(state!.outline, nodeId),
      depth,
    }
    await Promise.all(
      kinds.map(async (kind) => {
        let items: Suggestion[] = []
        let perspective = ""
        let error = ""
        try {
          const res = await fetch("/ai/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ...payload }) })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || "Request failed")
          perspective = data.perspective || ""
          items = data.items.map((i: Suggestion) => ({ ...i, id: uid(), status: "new" }))
        } catch (e) {
          error = e instanceof Error ? e.message : "Request failed"
        }
        setState((s) =>
          s ? { ...s, batches: s.batches.map((b) => (b.id === batch.id ? { ...b, items: [...b.items, ...items], ...(perspective ? { perspective } : {}), errors: { ...b.errors, ...(error ? { [kind]: error } : {}) } } : b)) } : s,
        )
        setPending((p) => ({ ...p, [nodeId]: { ...p[nodeId], [kind]: false } }))
      }),
    )
    setPending((p) => {
      const n = { ...p }
      delete n[nodeId]
      return n
    })
  }

  const markItem = (batchId: string, itemId: string, patch: Partial<Suggestion>) =>
    setState((s) =>
      s ? { ...s, batches: s.batches.map((b) => (b.id === batchId ? { ...b, items: b.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) } : b)) } : s,
    )

  function accept(batch: Batch, item: Suggestion, childIndex?: number) {
    if (!find(state!.outline, batch.nodeId)) return
    if (item.type === "evidence") {
      addChildren(batch.nodeId, [mk(item.statement || item.title, "evidence", "ai", item.url ?? "")])
      markItem(batch.id, item.id, { status: "added" })
    } else if (item.children.length) {
      const indexes = childIndex === undefined ? item.children.map((_, i) => i).filter((i) => !item.addedChildren?.includes(i)) : [childIndex]
      addChildren(batch.nodeId, indexes.map((i) => mk(item.childStatements?.[i] || item.children[i], "point", "ai")))
      const addedChildren = [...(item.addedChildren ?? []), ...indexes]
      markItem(batch.id, item.id, { addedChildren, status: addedChildren.length === item.children.length ? "added" : "new" })
    } else {
      addChildren(batch.nodeId, [mk(item.statement || item.title, "point", "ai")])
      markItem(batch.id, item.id, { status: "added" })
    }
  }

  function commitVersion() {
    const label = prompt("Name this version", `Version ${state!.versions.length + 1}`)
    if (!label) return
    setState((s) => (s ? { ...s, versions: [{ id: uid(), label, at: Date.now(), outline: structuredClone(s.outline) }, ...s.versions] } : s))
  }

  // Progress toward a compelling piece: thesis, key points, evidence per point.
  const keyPoints = state.outline.children.filter((c) => c.text.trim())
  const supported = keyPoints.filter(hasEvidence)
  const unsupported = keyPoints.find((c) => !hasEvidence(c))

  const renderNode = (n: Node, depth: number, readOnly: boolean): React.ReactNode => {
    if (depth > alt.depth) return null
    const isSel = selected === n.id && !readOnly
    const hiddenCount = depth === alt.depth ? count(n) - 1 : 0
    const thinking = pending[n.id]
    return (
      <li key={n.id}>
        <div className={`flex items-start gap-2.5 rounded-md px-2 py-1 transition ${isSel ? "bg-white shadow-[0_0_0_1px_rgb(231,229,228)]" : ""}`}>
          <span
            className={`mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full ${depth === 0 ? "hidden" : n.kind === "evidence" ? (n.source ? "bg-sky-600" : "bg-amber-400") : n.origin === "ai" ? "bg-amber-400" : "bg-stone-400"}`}
          />
          <div className="min-w-0 flex-1">
            {readOnly ? (
              <p className={depth === 0 ? "font-serif text-2xl" : "text-[15px] leading-relaxed"}>{n.text || <em className="text-stone-400">Empty</em>}</p>
            ) : (
              <textarea
                ref={(el) => {
                  if (el && focusNext.current === n.id) {
                    focusNext.current = null
                    el.focus()
                  }
                }}
                value={n.text}
                rows={1}
                placeholder={depth === 0 ? "Write your thesis: the one thing you want people to believe or do" : "Write a point"}
                onFocus={() => setSelected(n.id)}
                onChange={(e) => edit(n.id, { text: e.target.value, origin: "human" })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    addSiblingAfter(n.id)
                  } else if (e.key === "Tab") {
                    e.preventDefault()
                    if (e.shiftKey) outdent(n.id)
                    else indent(n.id)
                  } else if (e.key === "Backspace" && !n.text && depth > 0 && n.children.length === 0) {
                    e.preventDefault()
                    removeEmpty(n.id)
                  }
                }}
                className={`field-sizing-content w-full resize-none bg-transparent outline-none placeholder:text-stone-400 ${depth === 0 ? "font-serif text-2xl leading-snug" : "text-[15px] leading-relaxed"}`}
              />
            )}
            {(n.source || (n.origin === "ai" && n.kind === "evidence") || hiddenCount > 0 || thinking) && (
              <div className="flex flex-wrap items-center gap-1.5 pb-0.5 text-[11px]">
                {n.source ? (
                  <a href={n.source} target="_blank" rel="noreferrer" className="rounded bg-sky-50 px-1.5 py-0.5 text-sky-800 hover:underline">
                    Source: {hostname(n.source)}
                  </a>
                ) : n.kind === "evidence" ? (
                  <Tag tone="amber">Unverified, no source</Tag>
                ) : null}
                {hiddenCount > 0 && <Tag tone="stone">+{hiddenCount} below</Tag>}
                {thinking && <span className="animate-pulse text-stone-400">Thinking about this...</span>}
              </div>
            )}
            {alt.body && depth > 0 && (
              readOnly ? (
                n.body && <p className="mt-1 whitespace-pre-wrap font-serif text-[15px] leading-7 text-stone-700">{n.body}</p>
              ) : (
                <textarea
                  value={n.body}
                  placeholder="Write the prose for this point..."
                  onFocus={() => setSelected(n.id)}
                  onChange={(e) => edit(n.id, { body: e.target.value })}
                  className="field-sizing-content mt-1 mb-2 w-full resize-none border-l-2 border-stone-200 bg-transparent pl-3 font-serif text-[15px] leading-7 text-stone-700 outline-none placeholder:text-stone-300 focus:border-stone-400"
                />
              )
            )}
          </div>
        </div>
        {n.children.length > 0 && depth < alt.depth && (
          <ul className={`${depth === 0 ? "mt-4" : "ml-[11px] border-l border-stone-200 pl-3"}`}>{n.children.map((c) => renderNode(c, depth + 1, readOnly))}</ul>
        )}
      </li>
    )
  }

  const nodeBatches = sel ? state.batches.filter((b) => b.nodeId === sel.node.id) : []
  const [latest, ...earlier] = nodeBatches
  const isThesis = sel?.path.length === 1

  return (
    <div className="flex h-screen bg-[#f7f5f0] text-stone-900">
      <aside className="flex w-56 shrink-0 flex-col border-r border-stone-200 p-4">
        <p className="font-serif text-lg">Talkshop</p>
        <p className="mb-6 text-xs text-stone-500">You write. It pushes back.</p>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-stone-500">Altitude</p>
        <div className="space-y-0.5">
          {ALTITUDES.map((a, i) => (
            <button key={a.id} onClick={() => setAltitude(a.id)} className={`flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left text-sm ${altitude === a.id ? "bg-stone-900 text-white" : "hover:bg-stone-200"}`}>
              <span className="mt-0.5 w-3 text-xs opacity-60">{i + 1}</span>
              <span>{a.label}<span className="block text-[11px] opacity-60">{a.hint}</span></span>
            </button>
          ))}
        </div>

        <p className="mt-8 mb-2 text-[11px] font-medium uppercase tracking-wider text-stone-500">Strength</p>
        <div className="space-y-2 text-[13px]">
          <Check ok={state.outline.text.trim().length >= MIN_CHARS} onClick={() => focus(state.outline.id)}>Thesis written</Check>
          <Check ok={keyPoints.length >= 3} onClick={() => focus(state.outline.id)}>{keyPoints.length} key points <span className="text-stone-400">(aim 3-5)</span></Check>
          <Check ok={keyPoints.length > 0 && supported.length === keyPoints.length} onClick={() => unsupported && focus(unsupported.id)}>
            {supported.length}/{keyPoints.length} points have evidence
          </Check>
        </div>

        <div className="mt-auto space-y-1.5 text-[11px] text-stone-500">
          <p className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-sky-600" />Backed by a web source</p>
          <p className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />AI idea, unverified</p>
          <p className="pt-2 leading-relaxed">Enter new point · Tab indent · Shift+Tab outdent</p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-200 bg-[#f7f5f0]/90 px-10 py-3 backdrop-blur">
          <span className="text-sm text-stone-500">
            {viewing ? <>Viewing <b className="text-stone-900">{viewing.label}</b> (read only)</> : `${alt.label} · ${count(state.outline)} points`}
          </span>
          <div className="flex gap-2">
            {viewing ? (
              <>
                <Btn onClick={() => setViewing(null)}>Back to writing</Btn>
                <Btn primary onClick={() => { if (confirm("Replace the current outline with this version? Commit first to keep the current one.")) { setOutline(() => structuredClone(viewing.outline)); setViewing(null) } }}>Restore</Btn>
              </>
            ) : (
              <Btn onClick={commitVersion}>Save version</Btn>
            )}
          </div>
        </div>
        <ul className="mx-auto max-w-3xl px-10 py-12">{renderNode(outline, 0, !!viewing)}</ul>
      </main>

      <aside className="flex w-[420px] shrink-0 flex-col border-l border-stone-200 bg-white">
        <div className="flex border-b border-stone-200 text-sm">
          {(["suggest", "versions"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 py-3 ${tab === t ? "border-b-2 border-stone-900 font-medium" : "text-stone-500"}`}>
              {t === "suggest" ? "Suggestions" : `Versions (${state.versions.length})`}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "versions" ? (
            <div className="space-y-2">
              {state.versions.length === 0 && <Empty>Save a version when the outline reaches a state worth keeping.</Empty>}
              {state.versions.map((v) => (
                <button key={v.id} onClick={() => setViewing(v)} className={`block w-full rounded-lg border p-3 text-left ${viewing?.id === v.id ? "border-stone-900" : "border-stone-200 hover:border-stone-400"}`}>
                  <p className="text-sm font-medium">{v.label}</p>
                  <p className="text-xs text-stone-500">{new Date(v.at).toLocaleString()} · {count(v.outline)} points</p>
                  <p className="mt-1 line-clamp-2 font-serif text-sm text-stone-600">{v.outline.text}</p>
                </button>
              ))}
            </div>
          ) : viewing ? (
            <Empty>Go back to writing to see suggestions.</Empty>
          ) : !sel ? (
            <Empty>Start with your thesis. When you pause, ideas for building it out, challenges, and evidence from the web appear here.</Empty>
          ) : (
            <div className="space-y-6">
              <div>
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">{isThesis ? "On your thesis" : "On this point"}</p>
                  {sel.node.text.trim().length >= MIN_CHARS && (
                    <div className="flex gap-3">
                      {isThesis && (
                        <button disabled={!!pending[sel.node.id]} onClick={() => suggest(sel.node.id, ["evidence"])} className="text-xs text-stone-500 hover:text-stone-900 disabled:opacity-40">
                          Find evidence
                        </button>
                      )}
                      <button disabled={!!pending[sel.node.id]} onClick={() => suggest(sel.node.id)} className="text-xs text-stone-500 hover:text-stone-900 disabled:opacity-40">
                        More ideas
                      </button>
                    </div>
                  )}
                </div>
                <p className="mt-1 line-clamp-3 font-serif text-[15px] text-stone-700">{sel.node.text || "Empty"}</p>
                {sel.node.text.trim().length < MIN_CHARS && <p className="mt-3 text-sm text-stone-500">Keep writing. Suggestions appear when you pause.</p>}
              </div>

              {latest && (
                <BatchView batch={latest} pending={pending[sel.node.id]} isThesis={!!isThesis} stale={latest.text !== sel.node.text.trim()} onAccept={accept} onDismiss={(b, i) => markItem(b.id, i.id, { status: "dismissed" })} />
              )}

              {earlier.length > 0 && (
                <div className="border-t border-stone-100 pt-4">
                  <button onClick={() => setShowEarlier(!showEarlier)} className="text-xs text-stone-500 hover:text-stone-900">
                    {showEarlier ? "Hide" : "Show"} earlier suggestions ({earlier.length})
                  </button>
                  {showEarlier && (
                    <div className="mt-4 space-y-8">
                      {earlier.map((b) => (
                        <div key={b.id} className="space-y-2">
                          <p className="text-[11px] text-stone-400">For “{b.text.slice(0, 80)}{b.text.length > 80 ? "..." : ""}”</p>
                          <BatchView batch={b} isThesis={!!isThesis} onAccept={accept} onDismiss={(bb, i) => markItem(bb.id, i.id, { status: "dismissed" })} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

function BatchView({
  batch, pending, isThesis, stale, onAccept, onDismiss,
}: {
  batch: Batch
  pending?: { ideas?: boolean; evidence?: boolean }
  isThesis: boolean
  stale?: boolean
  onAccept: (b: Batch, i: Suggestion, childIndex?: number) => void
  onDismiss: (b: Batch, i: Suggestion) => void
}) {
  const groups: { type: SuggestionType; label: string; hint: string; loading?: boolean; error?: string }[] = [
    { type: "extend", label: isThesis ? "Ways to build this into a talk" : "Ways to strengthen this", hint: isThesis ? "Pick key points from any structure" : "Sharpen, connect, tighten", loading: pending?.ideas, error: batch.errors.ideas },
    { type: "evidence", label: "Evidence from the web", hint: "Stories, examples, surprising facts", loading: pending?.evidence, error: batch.errors.evidence },
    { type: "challenge", label: "Challenges", hint: "What a skeptic would ask", loading: pending?.ideas, error: batch.errors.ideas },
  ]
  // Below the thesis, evidence is the main job, so it leads.
  if (!isThesis) groups.unshift(groups.splice(1, 1)[0])
  return (
    <div className="space-y-6">
      {stale && <p className="text-xs text-stone-400">You have edited since these were suggested.</p>}
      {batch.perspective ? (
        <div className="rounded-lg bg-stone-100 px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-stone-500">Big picture</p>
          <p className="mt-1 text-[13px] leading-snug text-stone-700">{batch.perspective}</p>
        </div>
      ) : pending?.ideas ? (
        <Skeleton label="Stepping back..." />
      ) : null}
      {groups.map((g) => {
        const items = batch.items.filter((i) => i.type === g.type && i.status !== "dismissed")
        if (!g.loading && !items.length && !g.error) return null
        return (
          <section key={g.type} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">{g.label}</p>
              <p className="text-[11px] text-stone-400">{g.hint}</p>
            </div>
            {g.loading && !items.length && <Skeleton label={g.type === "evidence" ? "Searching the web..." : "Thinking..."} />}
            {g.error && g.type !== "challenge" && <p className="text-xs text-red-700">{g.error}</p>}
            {items.map((item) => (
              <Card key={item.id} item={item} onAccept={(ci) => onAccept(batch, item, ci)} onDismiss={() => onDismiss(batch, item)} />
            ))}
          </section>
        )
      })}
    </div>
  )
}

function Card({ item, onAccept, onDismiss }: { item: Suggestion; onAccept: (childIndex?: number) => void; onDismiss: () => void }) {
  const added = item.status === "added"
  const border = item.type === "challenge" ? "border-l-rose-300" : item.type === "evidence" ? (item.sourced ? "border-l-sky-500" : "border-l-amber-300") : "border-l-stone-300"
  return (
    <div className={`group rounded-lg border border-l-2 border-stone-200 ${border} p-3 ${added ? "opacity-60" : ""}`}>
      {item.type === "evidence" && (
        <div className="mb-1 flex items-center gap-1.5 text-[11px]">
          {item.evidenceType && <Tag tone="stone">{item.evidenceType}</Tag>}
          {item.sourced && item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer" className="truncate text-sky-700 hover:underline">{item.source || hostname(item.url)}</a>
          ) : (
            <Tag tone="amber">Source not confirmed</Tag>
          )}
        </div>
      )}
      <p className="text-sm font-medium leading-snug">{item.title}</p>
      {item.detail && <p className="mt-1 text-[13px] leading-snug text-stone-600">{item.detail}</p>}
      {item.children.length > 0 && (
        <ol className="mt-2 space-y-1">
          {item.children.map((c, i) => {
            const done = item.addedChildren?.includes(i)
            return (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <span className="mt-px w-3 shrink-0 text-stone-400">{i + 1}</span>
                <span className={`flex-1 ${done ? "text-stone-400" : ""}`}>{c}</span>
                <button disabled={done} onClick={() => onAccept(i)} className="shrink-0 rounded px-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40" aria-label="Add this point">
                  {done ? "Added" : "+"}
                </button>
              </li>
            )
          })}
        </ol>
      )}
      <div className="mt-2 flex items-center justify-end gap-3 text-xs">
        {!added && <button onClick={onDismiss} className="text-stone-400 opacity-0 transition group-hover:opacity-100 hover:text-stone-900">Dismiss</button>}
        {added ? (
          <span className="text-emerald-700">Added to outline</span>
        ) : (
          <button onClick={() => onAccept()} className="rounded-md bg-stone-900 px-2.5 py-1 text-white hover:bg-stone-700">
            {item.children.length ? "Add all points" : item.type === "challenge" ? "Add as point to address" : item.type === "evidence" ? "Add as evidence" : "Add"}
          </button>
        )}
      </div>
    </div>
  )
}

const hostname = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "")
  } catch {
    return u
  }
}
function Check({ ok, children, onClick }: { ok: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 text-left hover:text-stone-600">
      <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${ok ? "border-emerald-600 bg-emerald-600" : "border-stone-300"}`}>
        {ok && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
      </span>
      <span>{children}</span>
    </button>
  )
}
function Skeleton({ label }: { label: string }) {
  return (
    <div className="space-y-2 rounded-lg border border-stone-100 p-3">
      <p className="animate-pulse text-xs text-stone-400">{label}</p>
      <div className="h-2.5 w-3/4 animate-pulse rounded bg-stone-100" />
      <div className="h-2.5 w-1/2 animate-pulse rounded bg-stone-100" />
    </div>
  )
}
function Tag({ children, tone }: { children: React.ReactNode; tone: "sky" | "amber" | "stone" }) {
  const c = { sky: "bg-sky-50 text-sky-800", amber: "bg-amber-50 text-amber-800", stone: "bg-stone-100 text-stone-600" }[tone]
  return <span className={`max-w-[260px] truncate rounded px-1.5 py-0.5 ${c}`}>{children}</span>
}
function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return <button onClick={onClick} className={`rounded-md px-3 py-1.5 text-sm ${primary ? "bg-stone-900 text-white hover:bg-stone-700" : "border border-stone-300 hover:bg-stone-100"}`}>{children}</button>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-stone-300 p-4 text-sm leading-relaxed text-stone-500">{children}</p>
}
