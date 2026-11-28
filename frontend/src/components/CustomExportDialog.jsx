import { useEffect, useState } from "react";
import { FileXls } from "@phosphor-icons/react";
import { waNumbers } from "../lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/overlays";
import { Button } from "./ui/button";
import { Spinner } from "./ui/primitives";

export const EXPORT_COLUMNS = [
  ["customer", "Customer"], ["phone", "Phone"], ["number", "WhatsApp number"], ["date", "Date and time"],
  ["order_id", "Order ID"], ["product", "Product"], ["product_name", "Engraving name"], ["caption", "Caption"],
  ["charm", "Charm"], ["colour", "Colour"], ["quantity", "Quantity"], ["notes", "Notes"],
  ["missing", "Missing details"], ["status", "Status"],
];
const STATUSES = [
  ["saved", "Saved orders"], ["in_progress", "In progress (Order ID saved, details coming)"],
  ["collecting", "Being collected by the bot"], ["waiting", "Waiting"], ["chat", "Chats without an order"],
];
const PRODUCTS = [
  ["wallet", "Wallet"], ["purse", "Purse"], ["clutch", "Clutch"], ["passport cover", "Passport cover"],
  ["leather keychain", "Leather keychain"], ["keychain", "Keychain (metal)"], ["pen", "Pen"], ["bottle", "Bottle"],
  ["bracelet", "Bracelet"], ["kada", "Kada"], ["rakhi", "Rakhi"], ["chain", "Neck chain"],
  ["luggage tag", "Luggage tag"], ["sunglasses cover", "Sunglasses cover"], ["other", "Other / not known"],
];
const MEMORY = "customer-data-export";

const pad = (n) => String(n).padStart(2, "0");
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function range(kind) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (kind === "yesterday") {
    const s = new Date(start.getTime() - 86400000);
    return [localInput(s), localInput(new Date(start.getTime() - 60000))];
  }
  if (kind === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
  if (kind === "month") start.setDate(1);
  return [localInput(start), localInput(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59))];
}

function Checks({ items, value, onChange, testId }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {items.map(([k, l]) => (
        <label key={k} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={value.includes(k)}
            onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))}
            data-testid={`${testId}-${k}`}
          />
          {l}
        </label>
      ))}
    </div>
  );
}

/**
 * "Custom export": choose the columns, date range, WhatsApp numbers, statuses, product types and complete /
 * missing details, starting from the Customer Data page's filters. The last choices are remembered on this computer.
 */
export default function CustomExportDialog({ open, onClose, pageFilters, onExport, busy }) {
  const [numbers, setNumbers] = useState([]);
  const [opts, setOpts] = useState(null);

  useEffect(() => {
    if (!open) return;
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(MEMORY) || "{}");
    } catch {
      saved = {};
    }
    setOpts({
      columns: saved.columns?.length ? saved.columns : EXPORT_COLUMNS.map(([k]) => k),
      numbers: saved.numbers || [],
      statuses: saved.statuses || [],
      products: saved.products || [],
      completeness: saved.completeness || "",
      // the page's own filters come first: the window opens with what's on screen
      since: pageFilters.since || "",
      until: pageFilters.until || "",
      phone: pageFilters.phone || "",
      order_id: pageFilters.order_id || "",
      missing: pageFilters.missing || "",
      having: pageFilters.having || [],
    });
    waNumbers().then((list) => setNumbers((list || []).map((n) => n.label || n.logical_id).filter(Boolean)), () => setNumbers([]));
  }, [open, pageFilters]);

  if (!opts) return null;
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const run = () => {
    try {
      localStorage.setItem(MEMORY, JSON.stringify({ columns: opts.columns, numbers: opts.numbers, statuses: opts.statuses,
        products: opts.products, completeness: opts.completeness }));
    } catch {
      /* the choices just aren't remembered */
    }
    onExport({
      phone: opts.phone, order_id: opts.order_id, missing: opts.missing, having: opts.having,
      since: opts.since, until: opts.until,
      columns: opts.columns.join(","), numbers: opts.numbers.join(","), statuses: opts.statuses.join(","),
      products: opts.products.join(","), completeness: opts.completeness,
    });
  };
  const input = "mt-1 block w-full rounded-lg border border-line bg-white p-2 text-sm";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Custom export</DialogTitle>
          <DialogDescription>Pick what goes in the Excel file. Every column also gets a filter dropdown in Excel.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1">
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Columns</h3>
              <span className="space-x-3 text-xs">
                <button type="button" className="text-forest hover:underline" onClick={() => set("columns", EXPORT_COLUMNS.map(([k]) => k))}>All</button>
                <button type="button" className="text-forest hover:underline" onClick={() => set("columns", [])}>None</button>
              </span>
            </div>
            <Checks items={EXPORT_COLUMNS} value={opts.columns} onChange={(v) => set("columns", EXPORT_COLUMNS.map(([k]) => k).filter((k) => v.includes(k)))} testId="export-col" />
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-semibold">Dates</h3>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"]].map(([k, l]) => (
                <button key={k} type="button" className="rounded-full border border-line px-3 py-1 text-xs hover:bg-sand"
                  onClick={() => { const [a, b] = range(k); setOpts((o) => ({ ...o, since: a, until: b })); }} data-testid={`export-range-${k}`}>{l}</button>
              ))}
              <button type="button" className="rounded-full border border-line px-3 py-1 text-xs hover:bg-sand" onClick={() => setOpts((o) => ({ ...o, since: "", until: "" }))}>Any date</button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">From<input type="datetime-local" className={input} value={opts.since} onChange={(e) => set("since", e.target.value)} /></label>
              <label className="text-sm">Through<input type="datetime-local" className={input} value={opts.until} onChange={(e) => set("until", e.target.value)} /></label>
            </div>
          </section>

          {numbers.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">WhatsApp numbers <span className="font-normal text-muted">(none ticked = all)</span></h3>
              <Checks items={numbers.map((n) => [n, n])} value={opts.numbers} onChange={(v) => set("numbers", v)} testId="export-number" />
            </section>
          )}

          <section>
            <h3 className="mb-1.5 text-sm font-semibold">Status <span className="font-normal text-muted">(none ticked = all)</span></h3>
            <Checks items={STATUSES} value={opts.statuses} onChange={(v) => set("statuses", v)} testId="export-status" />
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-semibold">Details</h3>
            <div className="flex flex-wrap gap-4 text-sm">
              {[["", "All records"], ["complete", "Complete only"], ["missing", "Missing a required detail"]].map(([k, l]) => (
                <label key={k || "all"} className="flex items-center gap-1.5">
                  <input type="radio" name="completeness" checked={opts.completeness === k} onChange={() => set("completeness", k)} data-testid={`export-complete-${k || "all"}`} />
                  {l}
                </label>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-1.5 text-sm font-semibold">Product type <span className="font-normal text-muted">(none ticked = all)</span></h3>
            <Checks items={PRODUCTS} value={opts.products} onChange={(v) => set("products", v)} testId="export-product" />
          </section>

          {(opts.phone || opts.order_id) && (
            <p className="text-xs text-muted">
              Also using the page's search: {[opts.phone && `phone ${opts.phone}`, opts.order_id && `order ID ${opts.order_id}`].filter(Boolean).join(", ")}.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={run} disabled={busy || !opts.columns.length} data-testid="export-custom-run">
            {busy ? <Spinner /> : <FileXls size={18} />} Export to Excel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
