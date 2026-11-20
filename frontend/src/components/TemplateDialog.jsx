import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { PaperPlaneRight, ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, SimpleSelect } from "./ui/overlays";
import { Input, Label, Spinner, Alert } from "./ui/primitives";
import { Button } from "./ui/button";
import { getTemplates, sendTemplate, saveSettings, waNumbers, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";

// What a template blank can be filled with. "custom" means typed text.
const FIELDS = [
  { value: "customer_name", label: "Customer name" },
  { value: "order_id", label: "Order ID" },
  { value: "product_name", label: "Name on product" },
  { value: "charm", label: "Charm" },
  { value: "notes", label: "Notes" },
  { value: "shop_name", label: "Shop name" },
  { value: "phone", label: "Customer phone" },
  { value: "message", label: "Your message (typed in the reply box)" },
  { value: "custom", label: "Type it in" },
];
const FIELD_KEYS = new Set(FIELDS.map((f) => f.value).filter((v) => v !== "custom"));
const PH = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

const tplKey = (t) => `${t.name}|${t.language}`;

// Guess a field from a named blank like {{customer_name}} or {{order_id}}.
function guessField(name) {
  const n = name.toLowerCase();
  if (/message|update|text|detail/.test(n)) return "message";
  if (/order/.test(n)) return "order_id";
  if (/charm/.test(n)) return "charm";
  if (/print|product|engrav/.test(n)) return "product_name";
  if (/note/.test(n)) return "notes";
  if (/shop|store|brand|business/.test(n)) return "shop_name";
  if (/phone|mobile/.test(n)) return "phone";
  if (/name|customer/.test(n)) return "customer_name";
  return "custom";
}

// Saved mappings are "{field}" for a field, or plain text for typed values.
const fromSaved = (saved) => {
  const m = /^\{([a-z_]+)\}$/.exec(saved || "");
  return m && FIELD_KEYS.has(m[1]) ? { field: m[1], text: "" } : { field: "custom", text: saved || "" };
};
// Typed text is per customer (a name, an order ID), so it's never remembered as-is: if it matches one of
// this order's fields it's saved as that field, otherwise the blank is left empty next time.
const toSaved = (slot, ctx) => {
  if (slot.field !== "custom") return `{${slot.field}}`;
  const text = slot.text.trim();
  const match = text && Object.keys(ctx).find((k) => (ctx[k] || "").trim() === text);
  return match ? `{${match}}` : "";
};

const render = (text, names, values) => {
  const lookup = Object.fromEntries(names.map((n, i) => [n, values[i]]));
  return (text || "").replace(PH, (m, n) => (lookup[n] ? lookup[n] : `[${n}]`));
};

export { FIELDS, tplKey, guessField, fromSaved, render };

/**
 * Send an approved WhatsApp template.
 *  numberLabel / phone / contactName: who to send to (number can be changed if it isn't active).
 *  orders: orders that can fill the blanks; order: the one to start with (and mark as confirmed).
 *  confirmation: true when opened from "Send confirmation" (starts on the saved confirmation template).
 */
export default function TemplateDialog({
  open,
  onClose,
  numberLabel,
  phone,
  contactName = "",
  orders = [],
  order = null,
  confirmation = false,
  message = "",
  onSent,
}) {
  const { settings: appSettings } = useSession();
  const [numbers, setNumbers] = useState([]);
  const [number, setNumber] = useState("");
  const [data, setData] = useState(null); // { templates, settings }
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [orderId, setOrderId] = useState("");
  const [slots, setSlots] = useState({ header: [], body: [] });
  const [remember, setRemember] = useState(true);
  const [lateReply, setLateReply] = useState(false); // use this template for replies after the 24-hour window
  const [sending, setSending] = useState(false);
  const [savingOnly, setSavingOnly] = useState(false);

  const orderList = useMemo(() => {
    const list = [...orders];
    if (order && !list.some((o) => o.id === order.id)) list.unshift(order);
    return list;
  }, [orders, order]);
  const currentOrder = orderList.find((o) => o.id === orderId) || null;

  // Which numbers can send
  useEffect(() => {
    if (!open) return;
    setOrderId(order?.id || orderList[0]?.id || "");
    setRemember(true);
    waNumbers()
      .then((list) => {
        const active = list.filter((n) => n.active && n.token_ok);
        setNumbers(active);
        setNumber(active.some((n) => n.label === numberLabel) ? numberLabel : active[0]?.label || "");
      })
      .catch(() => setNumbers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const load = async (refresh = false) => {
    if (!number) return;
    setLoading(true);
    setLoadError("");
    try {
      const res = await getTemplates(number, refresh);
      setData(res);
      const sendable = res.templates.filter((t) => t.sendable);
      const conf = res.settings?.confirmation;
      const confKey = conf?.name ? `${conf.name}|${conf.language}` : "";
      setSelected((cur) => {
        if (cur && sendable.some((t) => tplKey(t) === cur)) return cur;
        if (confKey && sendable.some((t) => tplKey(t) === confKey)) return confKey;
        return sendable[0] ? tplKey(sendable[0]) : "";
      });
    } catch (e) {
      setData(null);
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && number) {
      setSelected("");
      load(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, number]);

  const tpl = data?.templates.find((t) => tplKey(t) === selected) || null;

  // Fill the blanks from the saved mapping, or a guess, whenever the template changes
  useEffect(() => {
    if (!tpl) return setSlots({ header: [], body: [] });
    const saved = data?.settings?.maps?.[tplKey(tpl)] || {};
    const build = (names, savedList = []) =>
      names.map((n, i) => (savedList[i] !== undefined ? fromSaved(savedList[i]) : { field: tpl.named ? guessField(n) : "custom", text: "" }));
    setSlots({ header: build(tpl.header_params, saved.header), body: build(tpl.body_params, saved.body) });
    const late = data?.settings?.late_reply;
    setLateReply(!!late?.name && `${late.name}|${late.language}` === tplKey(tpl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, data]);

  const ctx = {
    customer_name: contactName,
    order_id: currentOrder?.order_id || "",
    product_name: currentOrder?.product_name || "",
    charm: currentOrder?.charm || "",
    notes: currentOrder?.notes || "",
    shop_name: appSettings?.shop?.shop_name || "",
    phone: phone ? `+${phone}` : "",
    message,
  };
  const hasMessageBlank = [...slots.header, ...slots.body].some((x) => x.field === "message");
  const valueOf = (slot) => (slot.field === "custom" ? slot.text : ctx[slot.field] || "");
  const headerVals = slots.header.map(valueOf);
  const bodyVals = slots.body.map(valueOf);
  const missing = tpl ? [...headerVals, ...bodyVals].some((v) => !v.trim()) : true;

  const setSlot = (part, i, patch) =>
    setSlots((s) => ({ ...s, [part]: s[part].map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const nextSettings = () => {
    const s = data.settings || {};
    const me = { name: tpl.name, language: tpl.language };
    const isLate = s.late_reply?.name && `${s.late_reply.name}|${s.late_reply.language}` === tplKey(tpl);
    return {
      confirmation: confirmation || !s.confirmation?.name ? me : s.confirmation,
      late_reply: lateReply && hasMessageBlank ? me : isLate ? { name: "", language: "" } : s.late_reply || { name: "", language: "" },
      maps: {
        ...(s.maps || {}),
        [tplKey(tpl)]: { header: slots.header.map((x) => toSaved(x, ctx)), body: slots.body.map((x) => toSaved(x, ctx)) },
      },
    };
  };

  const saveOnly = async () => {
    if (!tpl) return;
    setSavingOnly(true);
    try {
      const res = await saveSettings("templates", nextSettings());
      setData((d) => ({ ...d, settings: res.templates }));
      toast.success(lateReply ? `Replies after 24 hours will be sent as "${tpl.name}"` : "Saved");
      onSent?.(null);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingOnly(false);
    }
  };

  const send = async () => {
    if (!tpl || missing) return;
    setSending(true);
    try {
      const res = await sendTemplate({
        number_label: number,
        to: phone,
        name: tpl.name,
        language: tpl.language,
        header_params: headerVals,
        body_params: bodyVals,
        order_id: currentOrder?.id || null,
      });
      if (remember) saveSettings("templates", nextSettings()).catch(() => {});
      toast.success(`Sent "${tpl.name}" to +${phone}`);
      onSent?.(res);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const unsendable = data?.templates.filter((t) => !t.sendable) || [];

  // A plain render function (not a component) so inputs keep focus while typing
  const blankRow = (part, name, i) => {
    const slot = slots[part][i];
    if (!slot) return null;
    return (
      <div key={`${part}-${name}`} className="grid grid-cols-[3.5rem_1fr_1.4fr] items-center gap-2">
        <span className="text-xs text-muted">
          {part === "header" && <span className="block text-[10px] uppercase tracking-wide">Title</span>}
          <span className="font-mono">{`{{${name}}}`}</span>
        </span>
        <SimpleSelect
          value={slot.field}
          onValueChange={(v) => setSlot(part, i, { field: v, text: v === "custom" ? valueOf(slot) : slot.text })}
          options={FIELDS}
          testId={`tpl-field-${part}-${i}`}
          className="h-9"
        />
        <Input
          data-testid={`tpl-value-${part}-${i}`}
          className="h-9 text-sm"
          value={valueOf(slot)}
          placeholder={slot.field === "custom" ? "Type the text" : "Empty for this order"}
          onChange={(e) => setSlot(part, i, { field: "custom", text: e.target.value })}
        />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{confirmation ? "Send order confirmation" : "Send a template"}</DialogTitle>
          <DialogDescription>
            Templates are messages Meta has approved. They can be sent any time, even after the 24-hour reply window. Meta charges a small
            fee for each one.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>To</Label>
              <div className="flex h-10 items-center rounded-lg border border-line bg-cream/60 px-3 font-mono text-sm">
                +{phone} {contactName && <span className="ml-2 truncate font-sans text-muted">{contactName}</span>}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>From number</Label>
              {numbers.length ? (
                <SimpleSelect value={number} onValueChange={setNumber} options={numbers.map((n) => ({ value: n.label, label: n.display ? `${n.label} (${n.display})` : n.label }))} testId="tpl-number-select" />
              ) : (
                <div className="flex h-10 items-center text-sm text-muted">No active WhatsApp number</div>
              )}
            </div>
          </div>

          {loading && !data ? (
            <div className="grid place-items-center py-8 text-forest">
              <Spinner />
            </div>
          ) : loadError ? (
            <Alert variant="warning" data-testid="tpl-load-error">
              <WarningCircle size={18} weight="fill" className="shrink-0" />
              <div>
                <div>{loadError}</div>
                <Link to="/settings?tab=whatsapp" className="mt-1 inline-block text-xs font-medium underline" onClick={onClose}>
                  Open WhatsApp number settings
                </Link>
              </div>
            </Alert>
          ) : data && !data.templates.some((t) => t.sendable) ? (
            <Alert variant="warning" data-testid="tpl-none">
              <WarningCircle size={18} weight="fill" className="shrink-0" />
              <div>
                No approved template on this number yet. Create one in{" "}
                {numbers.find((n) => n.label === number)?.provider === "360dialog" ? "the 360dialog Hub" : "Meta's WhatsApp Manager"} (category{" "}
                <b>Utility</b> for order updates), wait for approval, then click Reload.
              </div>
            </Alert>
          ) : data ? (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Template</Label>
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-forest hover:underline" onClick={() => load(true)} data-testid="tpl-reload-btn">
                    {loading ? <Spinner className="h-3 w-3" /> : <ArrowsClockwise size={12} />} Reload
                  </button>
                </div>
                <SimpleSelect
                  value={selected}
                  onValueChange={setSelected}
                  options={data.templates.filter((t) => t.sendable).map((t) => ({ value: tplKey(t), label: `${t.name} · ${t.language} · ${t.category.toLowerCase()}` }))}
                  testId="tpl-select"
                />
                {unsendable.length > 0 && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">{unsendable.length} other template{unsendable.length > 1 ? "s" : ""} can't be sent from here</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {unsendable.map((t) => (
                        <li key={tplKey(t)}>
                          <b>{t.name}</b> ({t.language}): {t.problem}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {orderList.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Order</Label>
                  <SimpleSelect
                    value={orderId || "none"}
                    onValueChange={(v) => setOrderId(v === "none" ? "" : v)}
                    options={[
                      ...orderList.map((o) => ({ value: o.id, label: `${o.order_id || "(no order ID)"}${o.product_name ? ` · ${o.product_name}` : ""}${o.confirmed_at ? " · confirmed" : ""}` })),
                      { value: "none", label: "No order" },
                    ]}
                    testId="tpl-order-select"
                  />
                  <p className="text-xs text-muted">The blanks fill in from this order, and it's marked as confirmed when the message is sent.</p>
                </div>
              )}

              {tpl && (tpl.header_params.length > 0 || tpl.body_params.length > 0) && (
                <div className="space-y-2">
                  <Label>Fill in the blanks</Label>
                  {tpl.header_params.map((n, i) => blankRow("header", n, i))}
                  {tpl.body_params.map((n, i) => blankRow("body", n, i))}
                </div>
              )}

              {tpl && (
                <div className="space-y-1.5">
                  <Label>Preview</Label>
                  <div className="rounded-xl bg-[#EFEAE1] p-3">
                    <div className="ml-auto max-w-[85%] rounded-xl rounded-tr-sm bg-[#DCF3D0] px-3 py-2 text-sm shadow-sm" data-testid="tpl-preview">
                      {tpl.header && <div className="mb-1 font-semibold">{render(tpl.header, tpl.header_params, headerVals)}</div>}
                      <div className="whitespace-pre-wrap break-words">{render(tpl.body, tpl.body_params, bodyVals)}</div>
                      {tpl.footer && <div className="mt-1 text-xs text-muted">{tpl.footer}</div>}
                      {tpl.buttons.length > 0 && (
                        <div className="mt-2 grid gap-1 border-t border-black/10 pt-1.5">
                          {tpl.buttons.map((b, i) => (
                            <div key={i} className="text-center text-xs font-medium text-sky-700">
                              {b}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid="tpl-remember" />
                Remember which field fills each blank{confirmation ? " and use this template for Send confirmation" : ""}
              </label>
              {hasMessageBlank && (
                <label className="flex items-start gap-2 rounded-lg border border-forest/30 bg-forest-50 p-2.5 text-xs text-ink" data-testid="tpl-late-reply-label">
                  <input type="checkbox" className="mt-0.5" checked={lateReply} onChange={(e) => setLateReply(e.target.checked)} data-testid="tpl-late-reply" />
                  <span>
                    <b>Use for replies after 24 hours.</b> When a chat's reply window has closed, staff just type in the reply box and it's sent
                    with this template, with the customer's details filled in. Meta charges a small fee for each one.
                  </span>
                </label>
              )}
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="tpl-cancel-btn">
            Cancel
          </Button>
          {tpl && hasMessageBlank && (
            <Button variant="outline" onClick={saveOnly} disabled={savingOnly || sending} data-testid="tpl-save-only-btn">
              {savingOnly ? <Spinner /> : null} Save without sending
            </Button>
          )}
          <Button onClick={send} disabled={!tpl || missing || sending || !number} data-testid="tpl-send-btn">
            {sending ? <Spinner /> : <PaperPlaneRight size={16} weight="fill" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
