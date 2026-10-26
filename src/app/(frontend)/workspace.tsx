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
  title: string // written to the author, shown beside the draft
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
type Batch = { id: string; nodeId: string; text: string; at: number; items: Suggestion[]; perspective?: string; steer?: string; errors: Partial<Record<"ideas" | "evidence", string>> }
type Version = { id: string; label: string; at: number; outline: Node }
// feedback: remembered steering notes per point; guidance: notes that apply to every suggestion.
type State = { outline: Node; batches: Batch[]; versions: Version[]; feedback: Record<string, string[]>; guidance: string[] }
type DropPos = "before" | "after" | "inside" // used by keyboard indent/outdent

const uid = () => Math.random().toString(36).slice(2, 10)
const mk = (text: string, kind: Kind = "point", origin: Node["origin"] = "human", source = ""): Node => ({
  id: uid(), text, kind, body: "", source, origin, children: [],
})
const STORAGE = "talk-workspace-v2"
const IDLE_MS = 2500
const MIN_CHARS = 12

const ALTITUDES = [
  { label: "Thesis", depth: 0, body: false },
  { label: "Key points", depth: 1, body: false },
  { label: "Support", depth: 99, body: false },
  { label: "Full draft", depth: 99, body: true },
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
// Whole outline as indented text, with the focused point marked, so suggestions fit the full argument.
const serialize = (n: Node, focusId: string, depth = 0): string =>
  [
    `${"  ".repeat(depth)}${n.id === focusId ? ">>> " : "- "}${depth === 0 ? "THESIS: " : n.kind === "evidence" ? "[evidence] " : ""}${n.text.trim() || "(empty)"}`,
    ...n.children.filter((c) => c.text.trim()).map((c) => serialize(c, focusId, depth + 1)),
  ].join("\n")
const flatten = (n: Node): Node[] => [n, ...n.children.flatMap(flatten)]
// Drop into the gap after row `afterId`, at outline depth `depth`: one deeper makes it the first
// child of that row; equal or shallower places it after that row's ancestor at that depth.
function placeAt(o: Node, id: string, afterId: string, depth: number): Node {
  const dragged = find(o, id)?.node
  if (!dragged || find(dragged, afterId)) return o
  const rest = removeNode(o, id)
  const anchor = find(rest, afterId)
  if (!anchor) return o
  const anchorDepth = anchor.path.length - 1
  if (depth === anchorDepth + 1) return update(rest, afterId, (n) => ({ ...n, children: [dragged, ...n.children] }))
  const sibling = anchor.path[depth]
  const parent = anchor.path[depth - 1]
  if (!sibling || !parent) return o
  return update(rest, parent.id, (n) => {
    const children = [...n.children]
    children.splice(children.findIndex((c) => c.id === sibling.id) + 1, 0, dragged)
    return { ...n, children }
  })
}
const INDENT = 22 // px per nesting level: ml-[9px] + border + pl-3

function moveNode(o: Node, id: string, targetId: string, pos: DropPos): Node {
  const dragged = find(o, id)?.node
  if (!dragged || id === targetId || find(dragged, targetId)) return o
  const rest = removeNode(o, id)
  if (pos === "inside") return update(rest, targetId, (n) => ({ ...n, children: [...n.children, dragged] }))
  const p = parentOf(rest, targetId)
  if (!p) return o
  return update(rest, p.id, (n) => {
    const children = [...n.children]
    const i = children.findIndex((c) => c.id === targetId)
    children.splice(pos === "before" ? i : i + 1, 0, dragged)
    return { ...n, children }
  })
}

export default function Workspace() {
  const [state, setState] = useState<State | null>(null)
  const [level, setLevel] = useState(2)
  const [toast, setToast] = useState<{ level: number; from: number; key: number } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Version | null>(null)
  const [pending, setPending] = useState<Record<string, { ideas?: boolean; evidence?: boolean }>>({})
  const [showEarlier, setShowEarlier] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ afterId: string; depth: number; parentId: string; top: number; left: number } | null>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const focusNext = useRef<string | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const levelRef = useRef(level)
  levelRef.current = level
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE)
      const s: State = { feedback: {}, guidance: [], ...(saved ? JSON.parse(saved) : { outline: mk("", "thesis"), batches: [], versions: [] }) }
      setState(s)
      if (!s.outline.text) focusNext.current = s.outline.id
    } catch {
      setState({ outline: mk("", "thesis"), batches: [], versions: [], feedback: {}, guidance: [] })
    }
  }, [])
  useEffect(() => {
    if (state) localStorage.setItem(STORAGE, JSON.stringify(state))
  }, [state])

  // Pinch (trackpad ctrl+wheel, Safari gesture, two-finger touch) or Cmd/Ctrl +/- to change altitude.
  useEffect(() => {
    let acc = 0
    let lockedUntil = 0
    const step = (dir: -1 | 1) => {
      const now = Date.now()
      if (now < lockedUntil) return
      const from = levelRef.current
      const to = Math.max(0, Math.min(ALTITUDES.length - 1, from + dir))
      lockedUntil = now + 450
      acc = 0
      setToast({ level: to, from, key: now })
      if (to !== from) setLevel(to)
    }
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      acc += e.deltaY
      if (acc > 40) step(-1)
      else if (acc < -40) step(1)
    }
    let gestureBase = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      gestureBase = 1
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const scale = (e as unknown as { scale: number }).scale
      if (scale / gestureBase < 0.8) { step(-1); gestureBase = scale }
      else if (scale / gestureBase > 1.25) { step(1); gestureBase = scale }
    }
    let touchBase = 0
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onTouchStart = (e: TouchEvent) => { if (e.touches.length === 2) touchBase = dist(e.touches) }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !touchBase) return
      e.preventDefault()
      const r = dist(e.touches) / touchBase
      if (r < 0.75) { step(-1); touchBase = dist(e.touches) }
      else if (r > 1.33) { step(1); touchBase = dist(e.touches) }
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === "-") { e.preventDefault(); lockedUntil = 0; step(-1) }
      else if (e.key === "=" || e.key === "+") { e.preventDefault(); lockedUntil = 0; step(1) }
    }
    window.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("gesturestart", onGestureStart)
    window.addEventListener("gesturechange", onGestureChange)
    window.addEventListener("touchstart", onTouchStart, { passive: true })
    window.addEventListener("touchmove", onTouchMove, { passive: false })
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("wheel", onWheel)
      window.removeEventListener("gesturestart", onGestureStart)
      window.removeEventListener("gesturechange", onGestureChange)
      window.removeEventListener("touchstart", onTouchStart)
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("keydown", onKey)
    }
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1400)
    return () => clearTimeout(t)
  }, [toast])

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

  if (!state) return null
  const alt = ALTITUDES[level]
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
    else setOutline((o) => moveNode(update(o, p.id, (n) => ({ ...n, children: [...n.children, node] })), node.id, id, "after"))
    focus(node.id)
  }
  function indent(id: string) {
    const p = parentOf(state!.outline, id)
    const i = p ? p.children.findIndex((c) => c.id === id) : -1
    if (!p || i < 1) return
    setOutline((o) => moveNode(o, id, p.children[i - 1].id, "inside"))
    focus(id)
  }
  function outdent(id: string) {
    const p = parentOf(state!.outline, id)
    if (!p || !parentOf(state!.outline, p.id)) return
    setOutline((o) => moveNode(o, id, p.id, "after"))
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
  async function suggest(nodeId: string, only?: ("ideas" | "evidence")[], steer?: { note: string; feedback: string[]; guidance: string[] }) {
    const target = find(state!.outline, nodeId)
    if (!target || pendingRef.current[nodeId]) return
    const depth = target.path.length - 1
    const kinds = only ?? (depth === 0 || depth >= 3 ? (["ideas"] as const) : (["ideas", "evidence"] as const))
    const text = target.node.text.trim()
    // A targeted request (e.g. evidence for the thesis) joins the current round instead of starting a new one.
    const current = state!.batches.find((b) => b.nodeId === nodeId)
    const reuse = only && current && current.text === text
    const batch: Batch = reuse ? current : { id: uid(), nodeId, text, at: Date.now(), items: [], errors: {}, steer: steer?.note }
    if (!reuse) setState((s) => (s ? { ...s, batches: [batch, ...s.batches] } : s))
    setPending((p) => ({ ...p, [nodeId]: Object.fromEntries(kinds.map((k) => [k, true])) }))
    setShowEarlier(false)
    const payload = {
      level: depth === 0 ? "thesis" : "point",
      text,
      outline: serialize(state!.outline, nodeId),
      depth,
      feedback: steer?.feedback ?? state!.feedback[nodeId] ?? [],
      guidance: steer?.guidance ?? state!.guidance,
      previous: current && !reuse ? current.items.map((i) => i.title) : [],
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

  function steer(nodeId: string, note: string, everywhere: boolean) {
    const feedback = everywhere ? state!.feedback[nodeId] ?? [] : [...(state!.feedback[nodeId] ?? []), note]
    const guidance = everywhere ? [...state!.guidance, note] : state!.guidance
    setState((s) => (s ? { ...s, guidance, feedback: { ...s.feedback, [nodeId]: feedback } } : s))
    suggest(nodeId, undefined, { note, feedback, guidance })
  }
  function forget(nodeId: string, note: string, everywhere: boolean) {
    setState((s) =>
      s ? everywhere ? { ...s, guidance: s.guidance.filter((g) => g !== note) } : { ...s, feedback: { ...s.feedback, [nodeId]: (s.feedback[nodeId] ?? []).filter((f) => f !== note) } } : s,
    )
  }

  function saveVersion() {
    const label = prompt("Name this version", `Version ${state!.versions.length + 1}`)
    if (!label) return
    setState((s) => (s ? { ...s, versions: [{ id: uid(), label, at: Date.now(), outline: structuredClone(s.outline) }, ...s.versions] } : s))
  }

  // Visible rows in order, excluding the subtree being dragged.
  function visibleRows() {
    const rows: { node: Node; depth: number; path: Node[] }[] = []
    const walk = (n: Node, depth: number, path: Node[]) => {
      if (n.id === drag) return
      rows.push({ node: n, depth, path: [...path, n] })
      if (depth < alt.depth) n.children.forEach((c) => walk(c, depth + 1, [...path, n]))
    }
    walk(state!.outline, 0, [])
    return rows
  }
  function onDragOver(e: React.DragEvent, overId: string | null) {
    if (!drag || !outlineRef.current) return
    e.preventDefault()
    e.stopPropagation()
    const rows = visibleRows()
    let gap = rows.length - 1
    if (overId) {
      const i = rows.findIndex((r) => r.node.id === overId)
      if (i < 0) return // hovering the dragged item itself
      const rect = e.currentTarget.getBoundingClientRect()
      gap = Math.max(0, e.clientY < rect.top + rect.height / 2 ? i - 1 : i)
    }
    const anchor = rows[gap]
    const next = rows[gap + 1]
    const maxDepth = anchor.depth + 1
    const minDepth = Math.max(1, next ? next.depth : 1)
    const box = outlineRef.current.getBoundingClientRect()
    const anchorRect = rowRefs.current[anchor.node.id]!.getBoundingClientRect()
    // Depth 0 and 1 rows share a left edge; each level after that is indented by INDENT.
    const baseLeft = anchorRect.left - box.left - Math.max(0, anchor.depth - 1) * INDENT
    const wanted = Math.round((e.clientX - box.left - baseLeft - 18) / INDENT) + 1
    const depth = Math.max(minDepth, Math.min(maxDepth, wanted))
    const parentId = depth === anchor.depth + 1 ? anchor.node.id : anchor.path[depth - 1].id
    const top = anchorRect.bottom - box.top
    const left = baseLeft + (depth - 1) * INDENT + 8
    if (drop?.afterId !== anchor.node.id || drop.depth !== depth || drop.top !== top) setDrop({ afterId: anchor.node.id, depth, parentId, top, left })
  }
  function endDrag() {
    setDrag(null)
    setDrop(null)
  }

  const renderNode = (n: Node, depth: number, readOnly: boolean): React.ReactNode => {
    if (depth > alt.depth) return null
    const isSel = selected === n.id && !readOnly
    const hiddenCount = depth === alt.depth ? count(n) - 1 : 0
    const thinking = pending[n.id]
    const isDropParent = drop?.parentId === n.id
    const dot = n.kind === "evidence" ? (n.source ? "bg-sky-600" : "bg-amber-400") : n.origin === "ai" ? "bg-amber-400" : "bg-stone-400"
    return (
      <li key={n.id} className={drag === n.id ? "opacity-40" : ""}>
        <div
          ref={(el) => { rowRefs.current[n.id] = el }}
          onDragOver={(e) => !readOnly && onDragOver(e, n.id)}
          className={`group relative -mx-2 flex items-start gap-1 rounded-lg py-0.5 pl-2 pr-2 transition-colors ${isDropParent ? "bg-sky-50" : isSel && !viewing ? "bg-white/80 shadow-[0_0_0_1px_rgb(231,229,228)]" : ""}`}
        >
          {depth > 0 && (
            <span
              draggable={!readOnly}
              onDragStart={(e) => {
                setDrag(n.id)
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData("text/plain", n.text)
                const row = rowRefs.current[n.id]
                if (row) e.dataTransfer.setDragImage(row, 12, 12)
              }}
              onDragEnd={endDrag}
              title="Drag to move"
              className={`relative mt-[7px] flex h-5 w-5 shrink-0 items-center justify-center rounded ${readOnly ? "" : "cursor-grab hover:bg-stone-200 active:cursor-grabbing"}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dot} ${readOnly ? "" : "group-hover:hidden"}`} />
              {!readOnly && <Grip className="hidden text-stone-400 group-hover:block" />}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {readOnly ? (
              <p className={depth === 0 ? "font-serif text-[28px] leading-tight" : "py-1 text-[16px] leading-relaxed"}>{n.text || <em className="text-stone-400">Empty</em>}</p>
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
                placeholder={depth === 0 ? "What's the one thing you want people to believe?" : ""}
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
                className={`field-sizing-content w-full resize-none bg-transparent outline-none placeholder:text-stone-300 ${depth === 0 ? "font-serif text-[28px] leading-tight" : "py-1 text-[16px] leading-relaxed"} ${isSel && depth > 0 ? "text-stone-950" : ""}`}
              />
            )}
            {(n.source || hiddenCount > 0 || thinking) && (
              <div className="-mt-0.5 flex flex-wrap items-center gap-2 pb-1 text-[11px] text-stone-400">
                {n.source && (
                  <a href={n.source} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">{hostname(n.source)}</a>
                )}
                {hiddenCount > 0 && <span>+{hiddenCount} below</span>}
                {thinking && <span className="animate-pulse">thinking</span>}
              </div>
            )}
            {alt.body && depth > 0 && (
              readOnly ? (
                n.body && <p className="mb-2 whitespace-pre-wrap font-serif text-[16px] leading-7 text-stone-600">{n.body}</p>
              ) : (
                <textarea
                  value={n.body}
                  placeholder="Write it out..."
                  onFocus={() => setSelected(n.id)}
                  onChange={(e) => edit(n.id, { body: e.target.value })}
                  className="field-sizing-content mb-2 w-full resize-none bg-transparent font-serif text-[16px] leading-7 text-stone-600 outline-none placeholder:text-stone-300"
                />
              )
            )}
          </div>
        </div>
        {n.children.length > 0 && depth < alt.depth && (
          <ul className={depth === 0 ? "mt-5" : "ml-[9px] border-l border-stone-200 pl-3"}>{n.children.map((c) => renderNode(c, depth + 1, readOnly))}</ul>
        )}
      </li>
    )
  }

  const nodeBatches = sel ? state.batches.filter((b) => b.nodeId === sel.node.id) : []
  const [latest, ...earlier] = nodeBatches
  const isThesis = sel?.path.length === 1
  const canSuggest = !!sel && !viewing && sel.node.text.trim().length >= MIN_CHARS

  return (
    <div className="min-h-screen bg-[#f7f5f0] text-stone-900" onClick={() => setShowVersions(false)}>
      {/* Versions: the only chrome, tucked in the corner */}
      <div className="fixed right-5 top-4 z-30" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setShowVersions(!showVersions)} className="rounded-full px-3 py-1 text-xs text-stone-400 hover:bg-stone-200/60 hover:text-stone-700">
          Versions{state.versions.length ? ` · ${state.versions.length}` : ""}
        </button>
        {showVersions && (
          <div className="absolute right-0 mt-1 w-64 rounded-xl border border-stone-200 bg-white p-1.5 shadow-lg">
            <button onClick={() => { saveVersion(); setShowVersions(false) }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-stone-100">Save this version</button>
            {state.versions.map((v) => (
              <button key={v.id} onClick={() => { setViewing(v); setSelected(null); setShowVersions(false) }} className="w-full rounded-lg px-3 py-2 text-left hover:bg-stone-100">
                <span className="block text-sm">{v.label}</span>
                <span className="block text-[11px] text-stone-400">{new Date(v.at).toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {viewing && (
        <div className="fixed left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full bg-stone-900 py-1.5 pl-4 pr-1.5 text-sm text-white shadow-lg">
          <span>Viewing {viewing.label}</span>
          <button onClick={() => setViewing(null)} className="rounded-full px-3 py-1 hover:bg-white/10">Back</button>
          <button
            onClick={() => { if (confirm("Replace the current outline with this version? Save first to keep the current one.")) { setOutline(() => structuredClone(viewing.outline)); setViewing(null) } }}
            className="rounded-full bg-white px-3 py-1 text-stone-900"
          >
            Restore
          </button>
        </div>
      )}

      <div className="relative mx-auto flex max-w-[1180px] gap-12 px-10 pb-[50vh] pt-24">
        <div
          ref={outlineRef}
          className="relative min-w-0 max-w-[660px] flex-1"
          onDragOver={(e) => onDragOver(e, null)}
          onDrop={(e) => {
            e.preventDefault()
            if (drag && drop) setOutline((o) => placeAt(o, drag, drop.afterId, drop.depth))
            endDrag()
          }}
        >
          <ul>{renderNode(outline, 0, !!viewing)}</ul>
          {drop && (
            <div className="pointer-events-none absolute right-0 z-10 flex items-center" style={{ top: drop.top - 3, left: drop.left }}>
              <span className="h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px] border-sky-500 bg-[#f7f5f0]" />
              <span className="h-0.5 flex-1 rounded bg-sky-500" />
            </div>
          )}
        </div>

        <div className="w-[360px] shrink-0">
          {sel && !viewing && (
            <div className="sticky top-16 max-h-[calc(100vh-6rem)] overflow-y-auto pb-6 pr-1">
              {canSuggest ? (
                <div className="space-y-5">
                  <div className="flex gap-3 text-[11px] text-stone-400">
                    <button disabled={!!pending[sel.node.id]} onClick={() => suggest(sel.node.id)} className="hover:text-stone-800 disabled:opacity-40">More ideas</button>
                    {isThesis && <button disabled={!!pending[sel.node.id]} onClick={() => suggest(sel.node.id, ["evidence"])} className="hover:text-stone-800 disabled:opacity-40">Find evidence</button>}
                  </div>
                  {latest && (
                    <BatchView key={latest.id} batch={latest} pending={pending[sel.node.id]} isThesis={!!isThesis} stale={latest.text !== sel.node.text.trim()} onAccept={accept} onDismiss={(b, i) => markItem(b.id, i.id, { status: "dismissed" })} />
                  )}
                  <Steer
                    key={sel.node.id}
                    notes={state.feedback[sel.node.id] ?? []}
                    guidance={state.guidance}
                    busy={!!pending[sel.node.id]}
                    onSubmit={(note, everywhere) => steer(sel.node.id, note, everywhere)}
                    onForget={(note, everywhere) => forget(sel.node.id, note, everywhere)}
                  />
                  {earlier.length > 0 && (
                    <div>
                      <button onClick={() => setShowEarlier(!showEarlier)} className="text-[11px] text-stone-400 hover:text-stone-800">
                        {showEarlier ? "Hide earlier" : `Earlier suggestions (${earlier.length})`}
                      </button>
                      {showEarlier && (
                        <div className="mt-4 space-y-6">
                          {earlier.map((b) => (
                            <div key={b.id} className="space-y-2 border-l border-stone-200 pl-3">
                              <p className="text-[11px] text-stone-400">For “{b.text.slice(0, 70)}{b.text.length > 70 ? "..." : ""}”</p>
                              <BatchView batch={b} isThesis={!!isThesis} onAccept={accept} onDismiss={(bb, i) => markItem(bb.id, i.id, { status: "dismissed" })} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : sel.node.kind !== "evidence" ? (
                <p className="pt-2 text-[13px] text-stone-400">Keep writing. Ideas appear when you pause.</p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div key={toast.key} className="pointer-events-none fixed bottom-8 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full bg-stone-900/95 px-2 py-1.5 text-[13px] text-stone-400 shadow-xl animate-[toast_1.4s_ease-out_forwards]">
          {ALTITUDES.map((a, i) => (
            <span key={a.label} className="flex items-center gap-1">
              {i > 0 && <span className="text-stone-600">→</span>}
              <span className={`rounded-full px-2.5 py-0.5 transition-colors ${i === toast.level ? "bg-white text-stone-900" : i === toast.from && toast.from !== toast.level ? "text-stone-300" : ""}`}>{a.label}</span>
            </span>
          ))}
        </div>
      )}
      <style>{`@keyframes toast { 0% { opacity: 0; transform: translateY(6px) } 12% { opacity: 1; transform: translateY(0) } 80% { opacity: 1 } 100% { opacity: 0 } }`}</style>
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
  const groups: { type: SuggestionType; label: string; loading?: boolean; error?: string }[] = [
    { type: "extend", label: isThesis ? "Ways to build this" : "Strengthen", loading: pending?.ideas, error: batch.errors.ideas },
    { type: "evidence", label: "Stories and examples", loading: pending?.evidence, error: batch.errors.evidence },
    { type: "challenge", label: "Push back", loading: pending?.ideas },
  ]
  // Below the thesis, evidence is the main job, so it leads.
  if (!isThesis) groups.unshift(groups.splice(1, 1)[0])
  return (
    <div className="space-y-5">
      {batch.steer && <p className="text-[11px] text-stone-400">Steered by “{batch.steer}”</p>}
      {stale && <p className="text-[11px] text-stone-400">Written for an earlier wording.</p>}
      {batch.perspective ? (
        <p className="text-[13px] italic leading-snug text-stone-500">{batch.perspective}</p>
      ) : pending?.ideas ? (
        <Shimmer />
      ) : null}
      {groups.map((g) => {
        const items = batch.items.filter((i) => i.type === g.type && i.status !== "dismissed")
        if (!g.loading && !items.length && !g.error) return null
        return (
          <section key={g.type}>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-stone-400">{g.label}</p>
            {g.loading && !items.length && <Shimmer label={g.type === "evidence" ? "searching the web" : undefined} />}
            {g.error && <p className="text-xs text-red-700">{g.error}</p>}
            <div className="space-y-0.5">
              {items.map((item) => (
                <Item key={item.id} item={item} onAccept={(ci) => onAccept(batch, item, ci)} onDismiss={() => onDismiss(batch, item)} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Steer({
  notes, guidance, busy, onSubmit, onForget,
}: {
  notes: string[]
  guidance: string[]
  busy: boolean
  onSubmit: (note: string, everywhere: boolean) => void
  onForget: (note: string, everywhere: boolean) => void
}) {
  const [text, setText] = useState("")
  const [everywhere, setEverywhere] = useState(false)
  const submit = () => {
    if (!text.trim() || busy) return
    onSubmit(text.trim(), everywhere)
    setText("")
  }
  return (
    <div className="border-t border-stone-200 pt-4">
      <div className="rounded-xl border border-stone-200 bg-white focus-within:border-stone-400">
        <textarea
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Steer the next round, e.g. “more personal stories”, “less about startups”"
          className="field-sizing-content block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 text-[13px] leading-snug outline-none placeholder:text-stone-400"
        />
        <div className="flex items-center justify-between px-3 pb-2 pt-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-stone-500">
            <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} className="h-3 w-3 accent-stone-900" />
            Remember for all points
          </label>
          <button disabled={!text.trim() || busy} onClick={submit} className="rounded-md bg-stone-900 px-2.5 py-1 text-[11px] text-white disabled:opacity-30">
            Try again
          </button>
        </div>
      </div>
      {(notes.length > 0 || guidance.length > 0) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {guidance.map((g) => <Note key={`g${g}`} text={g} everywhere onRemove={() => onForget(g, true)} />)}
          {notes.map((n) => <Note key={`n${n}`} text={n} onRemove={() => onForget(n, false)} />)}
        </div>
      )}
    </div>
  )
}
function Note({ text, everywhere, onRemove }: { text: string; everywhere?: boolean; onRemove: () => void }) {
  return (
    <span className="group/n inline-flex max-w-full items-center gap-1 rounded-full bg-stone-200/70 py-0.5 pl-2.5 pr-1 text-[11px] text-stone-600" title={everywhere ? "Remembered for all points" : "Remembered for this point"}>
      {everywhere && <span className="text-stone-400">All ·</span>}
      <span className="truncate">{text}</span>
      <button onClick={onRemove} aria-label="Forget this note" className="flex h-4 w-4 items-center justify-center rounded-full text-stone-400 hover:bg-stone-300 hover:text-stone-800">×</button>
    </span>
  )
}

function Item({ item, onAccept, onDismiss }: { item: Suggestion; onAccept: (childIndex?: number) => void; onDismiss: () => void }) {
  const added = item.status === "added"
  return (
    <div className={`group -mx-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white ${added ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-snug text-stone-800">{item.title}</p>
          {item.detail && <p className="mt-0.5 text-[12.5px] leading-snug text-stone-500">{item.detail}</p>}
          {item.type === "evidence" && (
            <p className="mt-0.5 text-[11px]">
              {item.sourced && item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">{item.source || hostname(item.url)}</a>
              ) : (
                <span className="text-amber-700">source not confirmed</span>
              )}
            </p>
          )}
        </div>
        {added ? (
          <span className="mt-0.5 text-[11px] text-stone-400">added</span>
        ) : (
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            <IconBtn label="Dismiss" onClick={onDismiss}>×</IconBtn>
            <IconBtn label={item.children.length ? "Add all" : "Add to outline"} onClick={() => onAccept()} strong>+</IconBtn>
          </div>
        )}
      </div>
      {item.children.length > 0 && (
        <ol className="mt-1.5 space-y-0.5 border-l border-stone-200 pl-2.5">
          {item.children.map((c, i) => {
            const done = item.addedChildren?.includes(i)
            return (
              <li key={i} className="group/c flex items-start gap-2 text-[12.5px] leading-snug">
                <span className={`flex-1 py-0.5 ${done ? "text-stone-400" : "text-stone-600"}`}>{c}</span>
                {done ? <span className="text-[11px] text-stone-400">added</span> : (
                  <span className="opacity-0 group-hover/c:opacity-100"><IconBtn label="Add this point" onClick={() => onAccept(i)}>+</IconBtn></span>
                )}
              </li>
            )
          })}
        </ol>
      )}
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
function IconBtn({ children, onClick, label, strong }: { children: React.ReactNode; onClick: () => void; label: string; strong?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={`flex h-6 w-6 items-center justify-center rounded-md text-base leading-none ${strong ? "text-stone-900 hover:bg-stone-900 hover:text-white" : "text-stone-400 hover:bg-stone-200 hover:text-stone-800"}`}>
      {children}
    </button>
  )
}
function Grip({ className }: { className?: string }) {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" className={className} fill="currentColor" aria-hidden>
      {[2, 7, 12].flatMap((y) => [<circle key={`a${y}`} cx="2.5" cy={y} r="1.2" />, <circle key={`b${y}`} cx="7.5" cy={y} r="1.2" />])}
    </svg>
  )
}
function Shimmer({ label }: { label?: string }) {
  return (
    <div className="space-y-1.5 py-1">
      {label && <p className="animate-pulse text-[11px] text-stone-400">{label}</p>}
      <div className="h-2 w-4/5 animate-pulse rounded bg-stone-200/70" />
      <div className="h-2 w-3/5 animate-pulse rounded bg-stone-200/70" />
    </div>
  )
}
