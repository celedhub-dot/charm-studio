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
} from "@phosphor-icons/react";
import {
  analyzePdf,
  annotatePdf,
  getExtractOptions,
  getOrders,
  createOrder,
  downloadBlob,
  filenameFromDisposition,
  errorMessage,
} from "../lib/api";
import { PageHeader, EmptyState } from "../components/common";
import { Card, CardContent, Badge, Input, Label, Switch, Spinner } from "../components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, SimpleSelect, Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/overlays";
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
};

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

function OverrideDialog({ page, orders, currentId, onPick, onClear, onClose, onCreated }) {
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState({ order_id: page?.detected_ids?.[0] || "", product_name: "", colour: "", charm: "", quantity: "", notes: "" });
  const [saving, setSaving] = useState(false);

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
      const created = await createOrder({ ...draft, source: "manual" });
      toast.success("Order created and assigned to this page");
      onCreated(created);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!page} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Page {page?.page}: choose an order</DialogTitle>
          <DialogDescription>
            {page?.detected_ids?.length ? (
              <>
                Detected ID: <span className="font-mono text-ink">{page.detected_ids.join(", ")}</span>
              </>
            ) : (
              "No order ID was detected on this page."
            )}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="pick">
          <TabsList>
            <TabsTrigger value="pick" data-testid="override-tab-pick">
              Pick existing
            </TabsTrigger>
            <TabsTrigger value="new" data-testid="override-tab-new">
              New order
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
              <Button onClick={create} disabled={saving} data-testid="override-create-btn">
                {saving ? <Spinner /> : <Plus size={16} />} Create &amp; assign
              </Button>
            </div>
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
  const { settings } = useSession();
  const defaults = settings?.labels;
  const [position, setPosition] = useState(defaults?.position || "bottom-right");
  const [skipUnmatched, setSkipUnmatched] = useState(!!defaults?.skip_unmatched);
  const [fontSize, setFontSize] = useState(defaults?.font_size || 8);
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
      const [res, all] = await Promise.all([analyzePdf(f, model, effort), getOrders()]);
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

  const pageStatus = (p) => (overrides[p.page] ? "manual" : p.status);

  const counts = useMemo(() => {
    const c = { matched: 0, not_found: 0, needs_review: 0, no_id: 0 };
    analysis?.pages.forEach((p) => {
      const s = pageStatus(p);
      c[s === "manual" ? "matched" : s] += 1;
    });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, overrides]);

  const generate = async () => {
    setGenerating(true);
    try {
      const ov = Object.fromEntries(Object.entries(overrides).map(([pg, o]) => [pg, o.id]));
      if (model) {
        for (const page of analysis.pages) {
          ov[page.page] ??= page.status === "matched" ? page.matches[0].id : "__unmatched__";
        }
      }
      const res = await annotatePdf(file, { position, skipUnmatched, fontSize, overrides: ov });
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
          {options?.models?.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
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
              <div className="grid gap-4 sm:grid-cols-3">
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
            {Object.keys(overrides).length > 0 && <Badge variant="accent">{Object.keys(overrides).length} manual</Badge>}
          </div>

          {analysis.pages.length === 0 ? (
            <EmptyState icon={UploadSimple} title="This PDF has no pages" />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {analysis.pages.map((p) => {
                const st = pageStatus(p);
                const meta = STATUS[st];
                const order = overrides[p.page] || (p.status === "matched" ? p.matches[0] : null);
                return (
                  <button
                    key={p.page}
                    data-testid={`page-card-${p.page}`}
                    onClick={() => setActivePage(p)}
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
                            ID <span className="font-mono text-ink">{p.detected_ids.join(", ")}</span>
                          </>
                        ) : (
                          "No ID detected"
                        )}
                      </div>
                      {order ? (
                        <div className="rounded-xl border border-forest/15 bg-forest-50/60 p-3 text-sm">
                          <div className="truncate"><span className="text-muted">Name:</span> {order.product_name || "—"}</div>
                          <div className="truncate"><span className="text-muted">Charm:</span> {order.charm || "—"}
                            {order.colour && <span className="text-muted"> · {order.colour}</span>}
                            {order.quantity && order.quantity !== "1" && <span className="text-muted"> · Qty {order.quantity}</span>}
                          </div>
                          <div className="truncate"><span className="text-muted">Notes:</span> {order.notes || "—"}</div>

                        </div>
                      ) : (
                        <div className="mt-auto text-xs font-medium text-terracotta-700 group-hover:underline">Click to pick or create an order</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activePage && (
        <OverrideDialog
          key={activePage.page}
          page={activePage}
          orders={orders}
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
            setOrders((list) => [o, ...list]);
            setOverrides((m) => ({ ...m, [activePage.page]: o }));
            setActivePage(null);
          }}
        />
      )}
    </div>
  );
}
