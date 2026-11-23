import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import Papa from "papaparse";
import { toast } from "sonner";
import {
  Plus,
  MagnifyingGlass,
  DownloadSimple,
  UploadSimple,
  Trash,
  PencilSimple,
  Check,
  X,
  Package,
  FilePdf,
  ChatCenteredText,
  PaperPlaneRight,
  SealCheck,
} from "@phosphor-icons/react";
import {
  getOrders,
  createOrder,
  updateOrder,
  deleteOrder,
  deleteAllOrders,
  bulkOrders,
  exportOrdersCsv,
  downloadOrderSheet,
  errorMessage,
} from "../lib/api";
import { PageHeader, SourceBadge, EmptyState, EditableRows } from "../components/common";
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Table, THead, TBody, TR, TH, TD, Spinner } from "../components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, ConfirmDialog } from "../components/ui/overlays";
import { Button } from "../components/ui/button";
import { emptyOrder, formatDate } from "../lib/utils";
import TemplateDialog from "../components/TemplateDialog";

const HEADER_ALIASES = {
  order_id: ["order_id", "orderid", "order id", "order", "id", "sub order no", "suborder", "sub_order_no"],
  product_name: ["product_name", "name", "name on product", "print name", "productname"],
  colour: ["colour", "color", "colours", "colors"],
  charm: ["charm", "charms", "charm number", "charm no"],
  quantity: ["quantity", "qty", "pcs", "pieces"],
  notes: ["notes", "note", "remarks", "comment", "comments"],
};

function mapCsvRow(row) {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const out = emptyOrder();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const key = aliases.find((a) => lower[a] !== undefined);
    if (key) out[field] = String(lower[key] ?? "").trim();
  }
  return out;
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const toInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromInput = (v) => {
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const niceDay = (d) => d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

const EMPTY_FILTERS = { date: "any", from: "", to: "", phone: "", orderId: "" };
const DATE_MODES = [
  ["any", "Any date"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["custom", "Pick dates"],
];

/** {start, end, title} for a date filter; null for "any"; {error} when the picked dates are incomplete. */
function dateRange(mode, from, to) {
  const today = dayStart(new Date());
  let first;
  let last;
  if (mode === "any") return null;
  if (mode === "today") first = last = today;
  else if (mode === "yesterday") first = last = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  else {
    if (!from) return { error: "Pick a date" };
    first = fromInput(from);
    last = to ? fromInput(to) : first; // one date = that whole day
    if (last < first) return { error: "The end date is before the start date" };
  }
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  const title = first.getTime() === last.getTime() ? niceDay(first) : `${niceDay(first)} to ${niceDay(last)}`;
  return { start: first, end, title };
}

function DateModeButtons({ value, onChange, testPrefix, allowAny = true }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DATE_MODES.filter(([v]) => allowAny || v !== "any").map(([v, l]) => (
        <button
          key={v}
          type="button"
          data-testid={`${testPrefix}-${v}`}
          onClick={() => onChange(v)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
            value === v ? "border-forest bg-forest-50 text-forest" : "border-line text-muted hover:border-forest/40"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function OrderSheetDialog({ open, onClose, initial }) {
  const today = dayStart(new Date());
  const [f, setF] = useState(EMPTY_FILTERS);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF({ ...EMPTY_FILTERS, date: "today", ...(initial || {}) });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF({ ...f, [k]: typeof e === "string" ? e : e.target.value });

  const download = async () => {
    const range = dateRange(f.date, f.from, f.to);
    if (range?.error) return toast.error(range.error);
    if (!range && !f.phone.trim() && !f.orderId.trim()) return toast.error("Choose a date, a phone number or an order ID");
    const bits = [range?.title, f.phone.trim() && `phone ${f.phone.trim()}`, f.orderId.trim() && `order ${f.orderId.trim()}`].filter(Boolean);
    setBusy(true);
    try {
      await downloadOrderSheet(range?.start || null, range?.end || null, bits.join(" · "), { phone: f.phone, order_id: f.orderId });
      onClose();
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
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Order sheet PDF</DialogTitle>
          <DialogDescription>
            A printable table of the matching orders: date and time, order ID, name, colour, charm, quantity, notes and phone. Filter by date, phone number,
            order ID, or any mix.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Date</Label>
          <DateModeButtons value={f.date} onChange={set("date")} testPrefix="sheet-mode" />
        </div>
        {f.date === "custom" && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sheet-from">From</Label>
              <Input id="sheet-from" type="date" data-testid="sheet-from-input" value={f.from} max={toInput(today)} onChange={set("from")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-to">To (optional)</Label>
              <Input id="sheet-to" type="date" data-testid="sheet-to-input" value={f.to} max={toInput(today)} onChange={set("to")} />
            </div>
            <p className="col-span-2 text-xs text-muted">One date for a single day, or a range of up to 3 months.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="sheet-phone">Phone (optional)</Label>
            <Input id="sheet-phone" data-testid="sheet-phone-input" inputMode="numeric" placeholder="e.g. 98765 43210" value={f.phone} onChange={set("phone")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sheet-order">Order ID (optional)</Label>
            <Input id="sheet-order" data-testid="sheet-order-input" placeholder="e.g. 123456789012_1" value={f.orderId} onChange={set("orderId")} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="sheet-cancel-btn">
            Cancel
          </Button>
          <Button onClick={download} disabled={busy} data-testid="sheet-download-btn">
            {busy ? <Spinner /> : <FilePdf size={16} />} Download PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const setFilter = (k) => (e) => setFilters((cur) => ({ ...cur, [k]: typeof e === "string" ? e : e.target.value }));
  const range = dateRange(filters.date, filters.from, filters.to);
  const filtered = !!(query.trim() || filters.phone.trim() || filters.orderId.trim() || range);
  const [form, setForm] = useState(emptyOrder());
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(emptyOrder());
  const [importRows, setImportRows] = useState(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmFor, setConfirmFor] = useState(null); // order being confirmed on WhatsApp
  const fileRef = useRef(null);

  const exportCsv = async () => {
    setExporting(true);
    try {
      await exportOrdersCsv(filtered && !range?.error ? { q: query, phone: filters.phone, order_id: filters.orderId, start: range?.start, end: range?.end } : undefined);
    } catch (err) {
      toast.error(errorMessage(err, "Could not export CSV"));
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async (f) => {
    setLoading(true);
    try {
      setOrders(await getOrders(f));
    } catch (e) {
      toast.error(errorMessage(e, "Could not load orders"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (range?.error) return undefined; // waiting for a date to be picked
    const t = setTimeout(
      () => load({ q: query, phone: filters.phone, order_id: filters.orderId, start: range?.start, end: range?.end }),
      300
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters, load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.order_id.trim()) return toast.error("Order ID is required");
    setSaving(true);
    try {
      const created = await createOrder({ ...form, source: "manual" });
      setOrders((o) => [created, ...o]);
      setForm(emptyOrder());
      toast.success("Order saved");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (o) => {
    setEditingId(o.id);
    setEditDraft({ order_id: o.order_id, product_name: o.product_name, colour: o.colour || "", charm: o.charm, quantity: o.quantity || "", notes: o.notes });
  };

  const saveEdit = async () => {
    try {
      const updated = await updateOrder(editingId, editDraft);
      setOrders((list) => list.map((o) => (o.id === updated.id ? updated : o)));
      setEditingId(null);
      toast.success("Order updated");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (id) => {
    try {
      await deleteOrder(id);
      setOrders((list) => list.filter((o) => o.id !== id));
      toast.success("Order deleted");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const removeAll = async () => {
    try {
      const res = await deleteAllOrders();
      setOrders([]);
      toast.success(`Deleted ${res.deleted} orders`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const onCsvPicked = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows = res.data.map(mapCsvRow).filter((r) => Object.values(r).some(Boolean));
        if (!rows.length) return toast.error("No rows found. Expected columns: order_id, product_name, colour, charm, quantity, notes");
        setImportRows(rows);
      },
      error: (err) => toast.error(`Could not read CSV: ${err.message}`),
    });
  };

  const confirmImport = async () => {
    setImporting(true);
    try {
      const res = await bulkOrders(importRows.map((r) => ({ ...r, source: "csv" })));
      toast.success(`Imported ${res.inserted} orders`);
      setImportRows(null);
      load(query);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const field = (key, label, props = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`order-${key}`}>{label}</Label>
      <Input
        id={`order-${key}`}
        data-testid={`order-form-${key}`}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        {...props}
      />
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Every customisation you have recorded, ready to stamp onto labels."
        actions={
          <>
            <Button variant="outline" data-testid="order-sheet-btn" onClick={() => setSheetOpen(true)}>
              <FilePdf size={16} /> Order sheet PDF
            </Button>
            <Button variant="outline" data-testid="export-csv-btn" onClick={exportCsv} disabled={exporting}>
              {exporting ? <Spinner /> : <DownloadSimple size={16} />} Export CSV
            </Button>
            <Button variant="outline" data-testid="import-csv-btn" onClick={() => fileRef.current?.click()}>
              <UploadSimple size={16} /> Import CSV
            </Button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={onCsvPicked} data-testid="import-csv-input" />
            <ConfirmDialog
              testId="delete-all"
              title="Delete all orders?"
              description="This permanently removes every order. It cannot be undone. Export a CSV first if you need a backup."
              confirmLabel="Delete all"
              onConfirm={removeAll}
              trigger={
                <Button variant="outline" data-testid="delete-all-btn" className="text-danger hover:border-danger/40 hover:bg-danger/5">
                  <Trash size={16} /> Delete all
                </Button>
              }
            />
          </>
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>New order</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="order-form">
            {field("order_id", "Order ID", { placeholder: "e.g. 123456789012_1", className: "font-mono" })}
            {field("product_name", "Name on product", { placeholder: "e.g. Aarav" })}
            {field("colour", "Colour", { placeholder: "e.g. Black" })}
            {field("charm", "Charm", { placeholder: "e.g. Heart, or 5" })}
            {field("quantity", "Quantity", { placeholder: "e.g. 1", inputMode: "numeric" })}
            {field("notes", "Notes", { placeholder: "Optional" })}
            <div className="md:col-span-2 lg:col-span-4">
              <Button type="submit" disabled={saving} data-testid="order-form-submit-btn">
                {saving ? <Spinner /> : <Plus size={16} />} Save order
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>
            {filtered ? "Matching orders" : "All orders"} <span className="ml-1 text-sm font-medium text-muted">({orders.length})</span>
          </CardTitle>
          <div className="relative w-full sm:w-72">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              data-testid="orders-search-input"
              placeholder="Search ID, name, colour, charm, notes, phone"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardHeader>
        <div className="grid gap-3 border-b border-line px-5 pb-4" data-testid="orders-filters">
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <DateModeButtons value={filters.date} onChange={setFilter("date")} testPrefix="filter-date" />
            </div>
            {filters.date === "custom" && (
              <div className="flex items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="filter-from">From</Label>
                  <Input id="filter-from" type="date" className="h-9" data-testid="filter-from-input" value={filters.from} onChange={setFilter("from")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="filter-to">To (optional)</Label>
                  <Input id="filter-to" type="date" className="h-9" data-testid="filter-to-input" value={filters.to} onChange={setFilter("to")} />
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="filter-phone">Phone</Label>
              <Input id="filter-phone" className="h-9 w-44" inputMode="numeric" placeholder="e.g. 98765 43210" data-testid="filter-phone-input" value={filters.phone} onChange={setFilter("phone")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-order">Order ID</Label>
              <Input id="filter-order" className="h-9 w-48" placeholder="e.g. 123456789012_1" data-testid="filter-order-input" value={filters.orderId} onChange={setFilter("orderId")} />
            </div>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setQuery("");
                }}
                data-testid="filters-clear-btn"
              >
                Clear filters
              </Button>
            )}
          </div>
          {range?.error && <p className="text-xs text-muted">{range.error} to filter by date.</p>}
        </div>
        <CardContent className="px-0 pb-2">
          {loading && orders.length === 0 ? (
            <div className="flex justify-center py-10 text-muted">
              <Spinner />
            </div>
          ) : orders.length === 0 ? (
            <div className="px-5 pb-3">
              <EmptyState
                icon={Package}
                title={filtered ? "No matches" : "No orders yet"}
                text={filtered ? "Try a different date, phone number or order ID." : "Use the form above to add your first order."}
              />
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH className="pl-5">Order ID</TH>
                  <TH>Name on product</TH>
                  <TH>Colour</TH>
                  <TH>Charm</TH>
                  <TH>Qty</TH>
                  <TH>Notes</TH>
                  <TH>Phone</TH>
                  <TH>Source</TH>
                  <TH>Order date</TH>
                  <TH className="pr-5 text-right">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {orders.map((o) =>
                  editingId === o.id ? (
                    <TR key={o.id} className="bg-forest-50/40">
                      {["order_id", "product_name", "colour", "charm", "quantity", "notes"].map((k, idx) => (
                        <TD key={k} className={idx === 0 ? "pl-5" : ""}>
                          <Input
                            data-testid={`edit-${k}-input`}
                            value={editDraft[k] || ""}
                            onChange={(e) => setEditDraft({ ...editDraft, [k]: e.target.value })}
                            className={k === "quantity" ? "h-9 w-16" : "h-9 min-w-[110px]"}
                          />
                        </TD>
                      ))}
                      <TD className="whitespace-nowrap font-mono text-xs text-muted">{o.customer_phone ? `+${o.customer_phone}` : "—"}</TD>
                      <TD>
                        <SourceBadge source={o.source} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs" title={`Saved in Custom Label ${formatDate(o.created_at)}`} data-testid={`order-date-${o.id}`}>
                        {o.order_date ? (
                          <span className="text-ink">{niceDay(fromInput(o.order_date))}</span>
                        ) : (
                          <span className="text-muted" title="Not found in the chat or on a label yet">—</span>
                        )}
                      </TD>
                      <TD className="pr-5">
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" onClick={saveEdit} data-testid="edit-save-btn" aria-label="Save">
                            <Check size={16} className="text-forest" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => setEditingId(null)} data-testid="edit-cancel-btn" aria-label="Cancel">
                            <X size={16} />
                          </Button>
                        </div>
                      </TD>
                    </TR>
                  ) : (
                    <TR key={o.id} data-testid={`order-row-${o.id}`}>
                      <TD className="pl-5 font-mono text-[13px]">
                        <span className="inline-flex items-center gap-1">
                          {o.order_id || "—"}
                          {o.confirmed_at && (
                            <SealCheck size={14} weight="fill" className="text-forest" title={`Confirmation sent ${formatDate(o.confirmed_at)}`} data-testid={`order-confirmed-icon-${o.id}`} />
                          )}
                        </span>
                      </TD>
                      <TD>{o.product_name || <span className="text-muted">—</span>}</TD>
                      <TD>{o.colour || <span className="text-muted">—</span>}</TD>
                      <TD>{o.charm || <span className="text-muted">—</span>}</TD>
                      <TD className="tabular-nums">{o.quantity || <span className="text-muted">—</span>}</TD>
                      <TD className="max-w-[220px] truncate" title={o.notes}>
                        {o.notes || <span className="text-muted">—</span>}
                      </TD>
                      <TD className="whitespace-nowrap">
                        {o.customer_phone ? (
                          o.channel ? (
                            <Link
                              to={`/chats?number=${encodeURIComponent(o.channel)}&phone=${o.customer_phone}`}
                              className="inline-flex items-center gap-1 font-mono text-xs text-forest hover:underline"
                              title="Open the chat"
                              data-testid={`order-chat-link-${o.id}`}
                            >
                              <ChatCenteredText size={13} /> +{o.customer_phone}
                            </Link>
                          ) : (
                            <span className="font-mono text-xs text-muted">+{o.customer_phone}</span>
                          )
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </TD>
                      <TD>
                        <SourceBadge source={o.source} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs" title={`Saved in Custom Label ${formatDate(o.created_at)}`} data-testid={`order-date-${o.id}`}>
                        {o.order_date ? (
                          <span className="text-ink">{niceDay(fromInput(o.order_date))}</span>
                        ) : (
                          <span className="text-muted" title="Not found in the chat or on a label yet">—</span>
                        )}
                      </TD>
                      <TD className="pr-5">
                        <div className="flex justify-end gap-1">
                          {o.customer_phone && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setConfirmFor(o)}
                              data-testid={`confirm-order-${o.id}-btn`}
                              aria-label="Send confirmation on WhatsApp"
                              title={o.confirmed_at ? `Confirmation sent ${formatDate(o.confirmed_at)}. Send again?` : "Send confirmation on WhatsApp"}
                            >
                              <PaperPlaneRight size={16} className={o.confirmed_at ? "text-muted" : "text-forest"} />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" onClick={() => startEdit(o)} data-testid={`edit-order-${o.id}-btn`} aria-label="Edit">
                            <PencilSimple size={16} />
                          </Button>
                          <ConfirmDialog
                            testId={`delete-order-${o.id}`}
                            title="Delete this order?"
                            description={`Order ${o.order_id || ""} will be removed permanently.`}
                            confirmLabel="Delete"
                            onConfirm={() => remove(o.id)}
                            trigger={
                              <Button size="icon" variant="ghost" data-testid={`delete-order-${o.id}-btn`} aria-label="Delete">
                                <Trash size={16} className="text-danger" />
                              </Button>
                            }
                          />
                        </div>
                      </TD>
                    </TR>
                  )
                )}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <OrderSheetDialog
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        initial={filtered && !range?.error ? { ...filters } : null}
      />

      <TemplateDialog
        open={!!confirmFor}
        onClose={() => setConfirmFor(null)}
        numberLabel={confirmFor?.channel || ""}
        phone={confirmFor?.customer_phone || ""}
        order={confirmFor}
        confirmation
        onSent={(res) => {
          if (res?.order) setOrders((list) => list.map((x) => (x.id === res.order.id ? res.order : x)));
        }}
      />

      <Dialog open={!!importRows} onOpenChange={(v) => !v && setImportRows(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Import preview</DialogTitle>
            <DialogDescription>
              {importRows?.length} rows found. Edit anything that looks off, then import.
            </DialogDescription>
          </DialogHeader>
          {importRows && <EditableRows rows={importRows} setRows={setImportRows} testPrefix="import" />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportRows(null)} data-testid="import-cancel-btn">
              Cancel
            </Button>
            <Button onClick={confirmImport} disabled={importing || !importRows?.length} data-testid="import-confirm-btn">
              {importing ? <Spinner /> : <UploadSimple size={16} />} Import {importRows?.length} orders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
