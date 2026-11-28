import { Trash, Plus } from "@phosphor-icons/react";
import { Badge, Input, Table, THead, TBody, TR, TH, TD } from "./ui/primitives";
import { Button } from "./ui/button";
import { cn, emptyOrder } from "../lib/utils";

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-enter mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-extrabold text-ink sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, icon: Icon, tone = "forest", hint, testId }) {
  return (
    <div data-testid={testId} className="hover-lift rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {Icon && (
          <span
            className={cn(
              "grid h-9 w-9 place-items-center rounded-xl",
              tone === "forest" && "bg-forest-50 text-forest",
              tone === "terracotta" && "bg-terracotta-50 text-terracotta",
              tone === "neutral" && "bg-sand text-muted"
            )}
          >
            <Icon size={18} weight="duotone" />
          </span>
        )}
      </div>
      <div className="mt-3 font-heading text-3xl font-extrabold text-ink">{value ?? "–"}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

const SOURCE_STYLE = {
  manual: "neutral",
  ai: "accent",
  csv: "outline",
  whatsapp: "default",
};

const SOURCE_LABEL = { ai: "AI", pending: "In progress", screenshot: "From screenshot" };

export function SourceBadge({ source }) {
  return (
    <Badge variant={SOURCE_STYLE[source] || "neutral"} title={source === "pending" ? "Order ID saved; the bot is still collecting the other details" : undefined}>
      {SOURCE_LABEL[source] || source || "manual"}
    </Badge>
  );
}

export function EmptyState({ icon: Icon, title, text, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-white/60 px-6 py-12 text-center">
      {Icon && (
        <span className="mb-1 grid h-12 w-12 place-items-center rounded-2xl bg-sand text-muted">
          <Icon size={22} />
        </span>
      )}
      <div className="font-heading font-bold text-ink">{title}</div>
      {text && <p className="max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Editable table for previewing extracted / imported rows before saving. */
export function EditableRows({ rows, setRows, testPrefix = "preview" }) {
  const update = (i, key, value) => setRows(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const remove = (i) => setRows(rows.filter((_, idx) => idx !== i));
  const cols = [
    ["order_id", "Order ID"],
    ["product_name", "Name on product"],
    ["colour", "Colour"],
    ["charm", "Charm"],
    ["quantity", "Qty"],
    ["notes", "Notes"],
  ];
  return (
    <div className="rounded-2xl border border-line bg-white">
      <Table>
        <THead>
          <tr>
            {cols.map(([k, l]) => (
              <TH key={k}>{l}</TH>
            ))}
            <TH className="w-12" />
          </tr>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={i}>
              {cols.map(([k]) => (
                <TD key={k} className="min-w-[140px] py-1.5">
                  <Input
                    data-testid={`${testPrefix}-row-${i}-${k}`}
                    value={r[k] || ""}
                    onChange={(e) => update(i, k, e.target.value)}
                    className="h-9"
                  />
                </TD>
              ))}
              <TD className="py-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid={`${testPrefix}-row-${i}-remove-btn`}
                  onClick={() => remove(i)}
                  aria-label="Remove row"
                >
                  <Trash size={16} className="text-danger" />
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <div className="border-t border-line p-2">
        <Button
          variant="ghost"
          size="sm"
          data-testid={`${testPrefix}-add-row-btn`}
          onClick={() => setRows([...rows, emptyOrder()])}
        >
          <Plus size={14} /> Add row
        </Button>
      </div>
    </div>
  );
}
