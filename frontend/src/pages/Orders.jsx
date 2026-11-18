import { useCallback, useEffect, useRef, useState } from "react";
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
} from "@phosphor-icons/react";
import {
  getOrders,
  createOrder,
  updateOrder,
  deleteOrder,
  deleteAllOrders,
  bulkOrders,
  apiUrl,
  errorMessage,
} from "../lib/api";
import { PageHeader, SourceBadge, EmptyState, EditableRows } from "../components/common";
import { Card, CardContent, CardHeader, CardTitle, Input, Label, Table, THead, TBody, TR, TH, TD, Spinner } from "../components/ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, ConfirmDialog } from "../components/ui/overlays";
import { Button } from "../components/ui/button";
import { emptyOrder, formatDate } from "../lib/utils";

const HEADER_ALIASES = {
  order_id: ["order_id", "orderid", "order id", "order", "id", "sub order no", "suborder", "sub_order_no"],
  product_name: ["product_name", "name", "name on product", "print name", "productname"],
  charm: ["charm", "charms"],
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

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(emptyOrder());
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(emptyOrder());
  const [importRows, setImportRows] = useState(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      setOrders(await getOrders(q));
    } catch (e) {
      toast.error(errorMessage(e, "Could not load orders"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(query), 250);
    return () => clearTimeout(t);
  }, [query, load]);

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
    setEditDraft({ order_id: o.order_id, product_name: o.product_name, charm: o.charm, notes: o.notes });
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
        if (!rows.length) return toast.error("No rows found. Expected columns: order_id, product_name, charm, notes");
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
            <Button variant="outline" asChild data-testid="export-csv-btn">
              <a href={apiUrl("/orders/export.csv")}>
                <DownloadSimple size={16} /> Export CSV
              </a>
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
            {field("charm", "Charm", { placeholder: "e.g. Heart, gold" })}
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
            All orders <span className="ml-1 text-sm font-medium text-muted">({orders.length})</span>
          </CardTitle>
          <div className="relative w-full sm:w-72">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              data-testid="orders-search-input"
              placeholder="Search ID, name, charm, notes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {loading && orders.length === 0 ? (
            <div className="flex justify-center py-10 text-muted">
              <Spinner />
            </div>
          ) : orders.length === 0 ? (
            <div className="px-5 pb-3">
              <EmptyState icon={Package} title={query ? "No matches" : "No orders yet"} text={query ? "Try a different search." : "Use the form above to add your first order."} />
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH className="pl-5">Order ID</TH>
                  <TH>Name on product</TH>
                  <TH>Charm</TH>
                  <TH>Notes</TH>
                  <TH>Source</TH>
                  <TH>Created</TH>
                  <TH className="pr-5 text-right">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {orders.map((o) =>
                  editingId === o.id ? (
                    <TR key={o.id} className="bg-forest-50/40">
                      {["order_id", "product_name", "charm", "notes"].map((k, idx) => (
                        <TD key={k} className={idx === 0 ? "pl-5" : ""}>
                          <Input
                            data-testid={`edit-${k}-input`}
                            value={editDraft[k]}
                            onChange={(e) => setEditDraft({ ...editDraft, [k]: e.target.value })}
                            className="h-9 min-w-[120px]"
                          />
                        </TD>
                      ))}
                      <TD>
                        <SourceBadge source={o.source} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-muted">{formatDate(o.created_at)}</TD>
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
                      <TD className="pl-5 font-mono text-[13px]">{o.order_id || "—"}</TD>
                      <TD>{o.product_name || <span className="text-muted">—</span>}</TD>
                      <TD>{o.charm || <span className="text-muted">—</span>}</TD>
                      <TD className="max-w-[220px] truncate" title={o.notes}>
                        {o.notes || <span className="text-muted">—</span>}
                      </TD>
                      <TD>
                        <SourceBadge source={o.source} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-muted">{formatDate(o.created_at)}</TD>
                      <TD className="pr-5">
                        <div className="flex justify-end gap-1">
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
