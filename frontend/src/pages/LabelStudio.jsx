import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  FilePdf,
  UploadSimple,
  DownloadSimple,
  CheckCircle,
  WarningCircle,
  MinusCircle,
  MagnifyingGlass,
  Plus,
  ArrowCounterClockwise,
  HandPointing,
  Eye,
  PencilSimple,
  Trash,
  Copy,
} from "@phosphor-icons/react";
import {
  analyzePdf,
  annotatePdf,
  getExtractOptions,
  getOrders,
  createOrder,
  updateOrder,
  previewLabel,
  downloadBlob,
  filenameFromDisposition,
  errorMessage,
} from "../lib/api";
import { PageHeader, EmptyState } from "../components/common";
import { Card, CardContent, Badge, Input, Label, Switch, Spinner } from "../components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, SimpleSelect, Tabs, TabsList, TabsTrigger, TabsContent, ConfirmDialog } from "../components/ui/overlays";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { useSession } from "../lib/session";

export const POSITIONS = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
];

const STATUS = {
  matched: { label: "Matched", variant: "default", icon: CheckCircle },
  manual: { label: "Matched (manual)", variant: "accent", icon: HandPointing },
  needs_review: { label: "Needs review", variant: "danger", icon: WarningCircle },
  not_found: { label: "Not found", variant: "danger", icon: WarningCircle },
  no_id: { label: "No ID", variant: "neutral", icon: MinusCircle },
  removed: { label: "No box", variant: "neutral", icon: MinusCircle },
};
/** Order IDs printed on the label, each with a copy button (copies exactly what the label prints). */
function CopyIds({ ids }) {
  return ids.map((id, i) => (
    <span key={id} className="inline-flex items-center gap-0.5">
      {i > 0 && <span className="text-muted">, </span>}
      <span className="font-mono text-ink">{id}</span>
      <button
        type="button"
        title={`Copy ${id}`}
        aria-label={`Copy order ID ${id}`}
        data-testid={`copy-id-${id}`}
        className="rounded p-0.5 text-muted hover:bg-sand hover:text-ink"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(id).then(() => toast.success(`Copied ${id}`), () => toast.error("Could not copy"));
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Copy size={13} />
      </button>
    </span>
  ));
}

/** "Matched on the first 12 digits": the saved order's ID differs from the label after that. */
function PartialNote({ page }) {
  if (!page?.match_digits) return null;
  return (
    <div className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800" data-testid={`partial-${page.page}`}>
      Matched on the first {page.match_digits} digits: saved as {page.match_order_id}. Please check.
    </div>
  );
}
const REMOVED = { removed: true }; // details taken off this label: it prints without a box
const DETAIL_KEYS = ["product_name", "charm", "colour", "quantity", "notes"];

/** The label page as it will print, with `details` in its box (or a red "not found" box, or no box). */
function LabelPreview({ file, page, opts, details, className }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const key = JSON.stringify(details ?? null);
  useEffect(() => {
    const controller = new AbortController();
    let made = "";
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const blob = await previewLabel(file, page, opts, details, controller.signal);
        made = URL.createObjectURL(blob);
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return made;
        });
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError("Couldn't make the preview. Try again.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, 450);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, page, opts.position, opts.fontSize, key]);
  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
  return (
    <div className={cn("relative grid min-h-48 place-items-center rounded-xl border border-line bg-sand/50 p-2", className)} data-testid="label-preview">
      {url && <img src={url} alt={`Page ${page} as it will print`} className={cn("max-h-[60vh] w-auto rounded border border-line bg-white", busy && "opacity-60")} />}
      {busy && <Spinner className="absolute h-6 w-6" />}
      {error && !busy && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

const detailsOf = (order) => (order ? Object.fromEntries(DETAIL_KEYS.map((k) => [k, order[k] || ""])) : null);

export function StickerPreview({ position }) {
  const pos = {
    "bottom-right": "bottom-1.5 right-1.5",
    "bottom-left": "bottom-1.5 left-1.5",
    "top-right": "top-1.5 right-1.5",
    "top-left": "top-1.5 left-1.5",
  }[position];
  return (
    <div className="relative h-16 w-12 shrink-0 rounded-md border border-line bg-white">
      <div className="absolute left-1.5 right-1.5 top-5 h-3 rounded-sm bg-[repeating-linear-gradient(90deg,#1F2A1B_0_1px,transparent_1px_3px)] opacity-40" />
      <div className={cn("absolute h-3 w-5 rounded-[2px] border border-forest bg-white", pos)}>
        <div className="h-1 bg-forest" />
      </div>
    </div>
  );
}

function OverrideDialog({ page, orders, currentId, current, file, opts, startTab, onPick, onClear, onClose, onCreated }) {
  const [q, setQ] = useState("");
  const editing = !!current?.id; // this label already has an order: edit that order, don't make a duplicate
  const [draft, setDraft] = useState({
    order_id: current?.order_id || page?.detected_ids?.[0] || "",
    product_name: current?.product_name || "",
    colour: current?.colour || "",
    charm: current?.charm || "",
    quantity: current?.quantity || "",
    notes: current?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? orders.filter((o) => [o.order_id, o.product_name, o.charm, o.notes].some((v) => (v || "").toLowerCase().includes(s)))
      : orders;
    return list.slice(0, 50);
  }, [q, orders]);

  const create = async () => {
    if (!draft.order_id.trim()) return toast.error("Order ID is required");
    setSaving(true);
    try {
      if (editing) {
        const updated = await updateOrder(current.id, draft);
        toast.success(`Order ${updated.order_id} updated`);
        onCreated(updated);
      } else {
        const created = await createOrder({ ...draft, source: "manual" });
        toast.success("Order created and assigned to this page");
        onCreated(created);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!page} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Page {page?.page}: choose an order</DialogTitle>
          <DialogDescription>
            {page?.detected_ids?.length ? (
              <>
                Detected ID: <CopyIds ids={page.detected_ids} />
              </>
            ) : (
              "No order ID was detected on this page."
            )}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue={startTab || (editing || !orders.length ? "new" : "pick")}>
          <TabsList>
            <TabsTrigger value="pick" data-testid="override-tab-pick">
              Pick existing
            </TabsTrigger>
            <TabsTrigger value="new" data-testid="override-tab-new">
              {editing ? "Edit details" : "New order"}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="pick">
            <div className="relative">
              <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                data-testid="override-search-input"
                placeholder="Search orders"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-9"
              />
            </div>
            <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {filtered.length === 0 && <li className="p-4 text-center text-sm text-muted">No orders found</li>}
              {filtered.map((o) => (
                <li key={o.id}>
                  <button
                    data-testid={`override-pick-${o.id}`}
                    onClick={() => onPick(o)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-forest-50",
                      currentId === o.id && "bg-forest-50"
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-sm">{o.order_id || "—"}</span>
                      <span className="block truncate text-xs text-muted">
                        {[o.product_name, o.charm, o.notes].filter(Boolean).join(" · ") || "No details"}
                      </span>
                    </span>
                    {currentId === o.id && <CheckCircle size={18} weight="fill" className="shrink-0 text-forest" />}
                  </button>
                </li>
              ))}
            </ul>
            {currentId && (
              <Button variant="ghost" size="sm" className="mt-3" onClick={onClear} data-testid="override-clear-btn">
                <ArrowCounterClockwise size={14} /> Remove manual choice
              </Button>
            )}
          </TabsContent>
          <TabsContent value="new">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
            {editing && (
              <p className="mb-3 rounded-lg bg-forest-50 px-3 py-2 text-xs text-forest">
                This label already has order <span className="font-mono">{current.order_id}</span>. Saving updates that order, so the label and the order stay the same.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["order_id", "Order ID"],
                ["product_name", "Name on product"],
                ["colour", "Colour"],
                ["charm", "Charm"],
                ["quantity", "Quantity"],
                ["notes", "Notes"],
              ].map(([k, l]) => (
                <div key={k} className="space-y-1.5">
                  <Label>{l}</Label>
                  <Input
                    data-testid={`override-new-${k}`}
                    value={draft[k]}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                    className={k === "order_id" ? "font-mono" : ""}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => (editing ? setConfirmSave(true) : create())} disabled={saving} data-testid="override-create-btn">
                {saving ? <Spinner /> : editing ? <PencilSimple size={16} /> : <Plus size={16} />} {editing ? "Save changes" : "Create & assign"}
              </Button>
            </div>
            </div>
            <div>
              <Label>Preview</Label>
              <LabelPreview file={file} page={page.page} opts={opts} details={detailsOf(draft)} className="mt-1.5" />
              <p className="mt-1.5 text-xs text-muted">Updates as you type: this is exactly how this label will print.</p>
            </div>
            </div>
            <ConfirmDialog
              open={confirmSave}
              onOpenChange={setConfirmSave}
              testId="override-save"
              title={`Change order ${current?.order_id || ""}?`}
              description="The saved order's details will change everywhere (Orders, Chats, this label)."
              confirmLabel="Save changes"
              onConfirm={create}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export default function LabelStudio() {
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [options, setOptions] = useState(null);
  useEffect(() => { getExtractOptions().then(setOptions).catch(() => {}); }, []);
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const { settings, me } = useSession();
  const defaults = settings?.labels;
  const [position, setPosition] = useState(defaults?.position || "bottom-right");
  const [skipUnmatched, setSkipUnmatched] = useState(!!defaults?.skip_unmatched);
  const [fontSize, setFontSize] = useState(defaults?.font_size || 8);
  const [engravingList, setEngravingList] = useState(true);
  // Settings may arrive after this page opens: apply the saved defaults once.
  const appliedDefaults = useRef(!!defaults);
  useEffect(() => {
    if (defaults && !appliedDefaults.current) {
      appliedDefaults.current = true;
      setPosition(defaults.position);
      setSkipUnmatched(!!defaults.skip_unmatched);
      setFontSize(defaults.font_size);
    }
  }, [defaults]);
  const [overrides, setOverrides] = useState({}); // page -> order
  const [activePage, setActivePage] = useState(null);
  const [orders, setOrders] = useState([]);
  const inputRef = useRef(null);

  const handleFile = async (f) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) return toast.error("Please choose a PDF file");
    setFile(f);
    setAnalysis(null);
    setOverrides({});
    setAnalyzing(true);
    try {
      const canViewOrders = me?.role !== "employee" || me.permissions.includes("orders");
      const [res, all] = await Promise.all([analyzePdf(f, model, effort), canViewOrders ? getOrders() : []]);
      setAnalysis(res);
      setOrders(all);
      toast.success(`Analysed ${res.summary.total_pages} pages`);
    } catch (e) {
      toast.error(errorMessage(e, "Could not analyse PDF"));
      setFile(null);
    } finally {
      setAnalyzing(false);
    }
  };

  const pageStatus = (p) => (overrides[p.page] === REMOVED ? "removed" : overrides[p.page] ? "manual" : p.status);
  const orderFor = (p) => (overrides[p.page] === REMOVED ? null : overrides[p.page] || (p.status === "matched" ? p.matches[0] : null));
  const [previewPage, setPreviewPage] = useState(null);
  const [removePage, setRemovePage] = useState(null);
  const opts = useMemo(() => ({ position, fontSize }), [position, fontSize]);

  const counts = useMemo(() => {
    const c = { matched: 0, not_found: 0, needs_review: 0, no_id: 0 };
    analysis?.pages.forEach((p) => {
      const s = pageStatus(p);
      if (s !== "removed") c[s === "manual" ? "matched" : s] += 1;
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, overrides]);

  const generate = async () => {
    setGenerating(true);
    try {
      const ov = Object.fromEntries(Object.entries(overrides).map(([pg, o]) => [pg, o === REMOVED ? "__none__" : o.id]));
      if (model) {
        for (const page of analysis.pages) {
          ov[page.page] ??= page.status === "matched" ? page.matches[0].id : "__unmatched__";
        }
      }
      const res = await annotatePdf(file, { position, skipUnmatched, fontSize, overrides: ov, engravingList });
      const name = filenameFromDisposition(res.headers["content-disposition"], `annotated_${file.name}`);
      downloadBlob(res.data, name);
      const matched = res.headers["x-matched-pages"] ?? "?";
      const nf = res.headers["x-not-found-pages"] ?? "?";
      const dates = Number(res.headers["x-order-dates-saved"] || 0);
      toast.success(`PDF ready: ${matched} matched, ${nf} not found${dates ? `. Saved the order date for ${dates} order${dates === 1 ? "" : "s"} from the labels` : ""}`);
    } catch (e) {
      let msg = errorMessage(e);
      if (e?.response?.data instanceof Blob) {
        try {
          msg = JSON.parse(await e.response.data.text()).detail || msg;
        } catch {
          /* keep default */
        }
      }
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  };

  const reset = () => {
    setFile(null);
    setAnalysis(null);
    setOverrides({});
  };

  return (
    <div>
      <PageHeader
        title="Label Studio"
        subtitle="Upload the day's label PDF from Meesho or Flipkart. We find each Order ID and put the customisation box right below each label. Small 4x6 labels come out 4 per A4 sheet: print at actual size (100%)."
        actions={
          analysis && (
            <Button variant="outline" onClick={reset} data-testid="label-reset-btn">
              <ArrowCounterClockwise size={16} /> New PDF
            </Button>
          )
        }
      />
      {!file && <div className="mb-5 flex flex-wrap gap-4 rounded-xl border border-line bg-white p-4">
        <label>Label reader <select className="ml-2 rounded border p-2" value={model} onChange={e => setModel(e.target.value)}>
          <option value="">Standard order matching (no AI charge)</option>
          {(me?.role !== "employee" || me.permissions.includes("ai_labels")) && options?.models?.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select></label>
        {model && <label>Effort <select className="ml-2 rounded border p-2" value={effort} onChange={e => setEffort(e.target.value)}>
          {options.efforts.map(e => <option key={e}>{e}</option>)}
        </select></label>}
      </div>}

      {!analysis && (
        <div
          data-testid="pdf-dropzone"
          onClick={() => !analyzing && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "page-enter flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-16 text-center transition-all",
            drag ? "scale-[1.01] border-forest bg-forest-50" : "border-line bg-white hover:border-forest/40"
          )}
        >
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-terracotta-50 text-terracotta">
            {analyzing ? <Spinner className="h-6 w-6" /> : <FilePdf size={28} weight="duotone" />}
          </span>
          <div className="font-heading text-lg font-bold">{analyzing ? `Reading ${file?.name}…` : "Drop your label PDF here"}</div>
          <div className="text-sm text-muted">Meesho and Flipkart A4 label PDFs work best · or click to browse</div>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            data-testid="pdf-file-input"
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {analysis && (
        <div className="page-enter grid gap-6">
          <Card>
            <CardContent className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:items-end">
              <div className="grid gap-4 sm:grid-cols-4">
                <div className="space-y-1.5">
                  <Label title="Meesho, Flipkart and most labels get the box right below the label. The corner is used only for layouts Custom Label doesn't recognise.">
                    Corner (unusual labels only)
                  </Label>
                  <div className="flex items-center gap-3">
                    <StickerPreview position={position} />
                    <SimpleSelect value={position} onValueChange={setPosition} options={POSITIONS} testId="sticker-position-select" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="font-size">Font size (pt)</Label>
                  <Input
                    id="font-size"
                    data-testid="font-size-input"
                    type="number"
                    min={5}
                    max={14}
                    step={0.5}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value) || 8)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="skip-unmatched">Skip unmatched pages</Label>
                  <div className="flex h-10 items-center gap-3">
                    <Switch id="skip-unmatched" data-testid="skip-unmatched-switch" checked={skipUnmatched} onCheckedChange={setSkipUnmatched} />
                    <span className="text-sm text-muted">{skipUnmatched ? "No red stickers" : "Mark with red sticker"}</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="engraving-list" title="A first page listing every name to engrave: golden strip, metal pen, metal keychain (two sides), bracelet, neck chain, rakhi, and labels with a name missing.">
                    Engraving list page
                  </Label>
                  <div className="flex h-10 items-center gap-3">
                    <Switch id="engraving-list" data-testid="engraving-list-switch" checked={engravingList} onCheckedChange={setEngravingList} />
                    <span className="text-sm text-muted">{engravingList ? "Added at the front" : "Not added"}</span>
                  </div>
                </div>
              </div>
              <Button variant="accent" size="lg" onClick={generate} disabled={generating} data-testid="generate-pdf-btn">
                {generating ? <Spinner /> : <DownloadSimple size={18} />} Generate &amp; Download PDF
              </Button>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="mr-1 font-medium text-ink">{analysis.filename}</span>
            <Badge variant="default" data-testid="summary-matched">{counts.matched} matched</Badge>
            <Badge variant="danger" data-testid="summary-not-found">{counts.not_found} not found</Badge>
            {counts.needs_review > 0 && <Badge variant="danger">{counts.needs_review} need review</Badge>}
            <Badge variant="neutral" data-testid="summary-no-id">{counts.no_id} no ID</Badge>
            {Object.values(overrides).filter((o) => o !== REMOVED).length > 0 && <Badge variant="accent">{Object.values(overrides).filter((o) => o !== REMOVED).length} manual</Badge>}
            {Object.values(overrides).filter((o) => o === REMOVED).length > 0 && <Badge variant="neutral">{Object.values(overrides).filter((o) => o === REMOVED).length} without box</Badge>}
          </div>

          {analysis.pages.length === 0 ? (
            <EmptyState icon={UploadSimple} title="This PDF has no pages" />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {analysis.pages.map((p) => {
                const st = pageStatus(p);
                const meta = STATUS[st];
                const order = orderFor(p);
                return (
                  <div
                    key={p.page}
                    role="button"
                    tabIndex={0}
                    data-testid={`page-card-${p.page}`}
                    onClick={() => setActivePage(p)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && setActivePage(p)}
                    className={cn(
                      "hover-lift group flex flex-col overflow-hidden rounded-2xl border bg-white text-left shadow-card",
                      st === "not_found" ? "border-danger/30" : "border-line"
                    )}
                  >
                    <div className="relative bg-sand/60 p-3">
                      <img src={p.thumbnail} alt={`Page ${p.page}`} className="mx-auto max-h-64 rounded-md border border-line bg-white object-contain" />
                      <span className="absolute left-3 top-3 rounded-md bg-ink/80 px-2 py-0.5 text-[11px] font-semibold text-white">
                        Page {p.page}
                      </span>
                      <Badge variant={meta.variant} className="absolute right-3 top-3 bg-white shadow-card">
                        <meta.icon size={12} weight="fill" /> {meta.label}
                      </Badge>
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-4">
                      <div className="text-xs text-muted">
                        {p.detected_ids.length ? (
                          <>
                            ID <CopyIds ids={p.detected_ids} />
                          </>
                        ) : (
                          "No ID detected"
                        )}
                      </div>
                      {st === "matched" && <PartialNote page={p} />}
                      {order ? (
                        <div className="rounded-xl border border-forest/15 bg-forest-50/60 p-3 text-sm">
                          <div className="truncate"><span className="text-muted">Name:</span> {order.product_name || "—"}</div>
                          <div className="truncate"><span className="text-muted">Charm:</span> {order.charm || "—"}
                            {order.colour && <span className="text-muted"> · {order.colour}</span>}
                            {order.quantity && order.quantity !== "1" && <span className="text-muted"> · Qty {order.quantity}</span>}
                          </div>
                          <div className="truncate"><span className="text-muted">Notes:</span> {order.notes || "—"}</div>

                        </div>
                      ) : st === "removed" ? (
                        <div className="text-xs text-muted">Details removed: this label prints without a box.</div>
                      ) : (
                        <div className="mt-auto text-xs font-medium text-terracotta-700 group-hover:underline">Click to pick or create an order</div>
                      )}
                      <div className="mt-auto flex flex-wrap gap-1.5 pt-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="outline" onClick={() => setPreviewPage(p)} data-testid={`page-preview-${p.page}`}>
                          <Eye size={14} /> Preview
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setActivePage({ ...p, startTab: "new" })} data-testid={`page-edit-${p.page}`}>
                          {order ? <PencilSimple size={14} /> : <Plus size={14} />} {order ? "Edit details" : "Add details"}
                        </Button>
                        {order && (
                          <Button size="sm" variant="ghost" className="text-danger hover:bg-red-50" onClick={() => setRemovePage(p)} data-testid={`page-remove-${p.page}`}>
                            <Trash size={14} /> Remove
                          </Button>
                        )}
                        {st === "removed" && (
                          <Button size="sm" variant="ghost" onClick={() => setOverrides(({ [p.page]: _d, ...rest }) => rest)} data-testid={`page-undo-${p.page}`}>
                            <ArrowCounterClockwise size={14} /> Undo
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {previewPage && (
        <Dialog open onOpenChange={(v) => !v && setPreviewPage(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Page {previewPage.page}: print preview</DialogTitle>
              {previewPage.detected_ids?.length > 0 && (
                <div className="text-xs text-muted">
                  Label ID: <CopyIds ids={previewPage.detected_ids} />
                </div>
              )}
              {pageStatus(previewPage) === "matched" && <PartialNote page={previewPage} />}
              <DialogDescription>
                {orderFor(previewPage)
                  ? `Order ${orderFor(previewPage).order_id}`
                  : pageStatus(previewPage) === "removed"
                    ? "Details removed: no box on this label."
                    : skipUnmatched
                      ? "No order: this label prints without a box (Skip unmatched pages is on)."
                      : "No order: this label gets a red ORDER NOT FOUND box."}
              </DialogDescription>
            </DialogHeader>
            <LabelPreview
              file={file}
              page={previewPage.page}
              opts={opts}
              details={
                orderFor(previewPage)
                  ? detailsOf(orderFor(previewPage))
                  : pageStatus(previewPage) === "removed" || skipUnmatched
                    ? null
                    : { not_found: true, id: previewPage.detected_ids[0] || "" }
              }
            />
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={!!removePage}
        onOpenChange={(v) => !v && setRemovePage(null)}
        testId="page-remove"
        title={`Remove the details from page ${removePage?.page || ""}?`}
        description="This label will print without a customisation box. The saved order isn't changed or deleted, and you can undo this before downloading."
        confirmLabel="Remove details"
        onConfirm={() => {
          const pg = removePage.page;
          setOverrides((m) => ({ ...m, [pg]: REMOVED }));
          setRemovePage(null);
          toast.success(`Page ${pg}: details removed from the label`);
        }}
      />

      {activePage && (
        <OverrideDialog
          key={activePage.page}
          page={activePage}
          orders={orders}
          file={file}
          opts={opts}
          current={orderFor(activePage)}
          startTab={activePage.startTab}
          currentId={overrides[activePage.page]?.id}
          onClose={() => setActivePage(null)}
          onPick={(o) => {
            setOverrides((m) => ({ ...m, [activePage.page]: o }));
            setActivePage(null);
          }}
          onClear={() => {
            setOverrides(({ [activePage.page]: _drop, ...rest }) => rest);
            setActivePage(null);
          }}
          onCreated={(o) => {
            setOrders((list) => [o, ...list.filter((x) => x.id !== o.id)]);
            setOverrides((m) => ({ ...m, [activePage.page]: o }));
            setActivePage(null);
          }}
        />
      )}
    </div>
  );
}
