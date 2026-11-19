import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  MagnifyingGlass,
  PaperPlaneRight,
  ArrowLeft,
  Check,
  Checks,
  WarningCircle,
  Robot,
  User,
  DeviceMobile,
  ArrowsClockwise,
  FloppyDisk,
  ChatsTeardrop,
  Clock,
  Copy,
  Package,
  Plus,
  FileText,
  SealCheck,
  Paperclip,
  X,
} from "@phosphor-icons/react";
import {
  getConversations,
  getThread,
  sendInboxMessage,
  sendInboxMedia,
  readOrdersAgain,
  updateOrder,
  createOrder,
  waNumbers,
  errorMessage,
} from "../lib/api";
import { Input, Label, Textarea, Badge, Spinner } from "../components/ui/primitives";
import { SimpleSelect } from "../components/ui/overlays";
import { Button } from "../components/ui/button";
import { EmptyState, SourceBadge } from "../components/common";
import { cn, timeAgo } from "../lib/utils";
import TemplateDialog from "../components/TemplateDialog";
import MessageMedia, { fmtSize } from "../components/MessageMedia";

const ORDER_FIELDS = ["order_id", "product_name", "charm", "notes"];
const fmtPhone = (p) => (p ? `+${p}` : "");
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

function hoursLeft(iso) {
  if (!iso) return 0;
  return Math.max(0, (new Date(iso).getTime() - Date.now()) / 3600000);
}

/* ---------- Conversation list ---------- */
function ConversationList({ items, loading, selected, onSelect, query, setQuery, numbers, number, setNumber }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            data-testid="chats-search-input"
            placeholder="Phone, name, order ID or message"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {numbers.length > 1 && (
          <SimpleSelect
            value={number || "all"}
            onValueChange={(v) => setNumber(v === "all" ? "" : v)}
            options={[{ value: "all", label: "All numbers" }, ...numbers.map((n) => ({ value: n.label, label: n.label }))]}
            testId="chats-number-filter"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="chats-list">
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-10 text-muted">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">{query ? "No chats match your search." : "No chats yet."}</p>
        ) : (
          items.map((c) => {
            const active = selected && selected.label === c.number_label && selected.phone === c.customer_phone;
            return (
              <button
                key={`${c.number_label}|${c.customer_phone}`}
                data-testid={`chat-item-${c.customer_phone}`}
                onClick={() => onSelect({ label: c.number_label, phone: c.customer_phone })}
                className={cn(
                  "flex w-full items-start gap-3 border-b border-line/60 px-3 py-3 text-left transition-colors",
                  active ? "bg-forest-50" : "hover:bg-cream"
                )}
              >
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sand font-heading text-sm font-bold text-forest">
                  {(c.name || c.customer_phone).slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{c.name || fmtPhone(c.customer_phone)}</span>
                    <span className="shrink-0 text-[11px] text-muted">{timeAgo(c.last_message_at)}</span>
                  </div>
                  {c.name && <div className="truncate font-mono text-[11px] text-muted">{fmtPhone(c.customer_phone)}</div>}
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.last_preview}</span>
                    {c.unread > 0 && (
                      <span className="grid h-5 min-w-5 place-items-center rounded-full bg-terracotta px-1.5 text-[10px] font-bold text-white">{c.unread}</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {numbers.length > 1 && <Badge variant="outline">{c.number_label}</Badge>}
                    {c.order_count > 0 && (
                      <Badge>
                        <Package size={10} /> {c.order_count} order{c.order_count > 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ---------- Messages ---------- */
const SOURCE_META = {
  bot: { label: "Bot", icon: Robot },
  staff: { label: "Staff", icon: User },
  phone_app: { label: "Phone app", icon: DeviceMobile },
};

function StatusTick({ m }) {
  if (m.status === "failed")
    return (
      <span title={m.error || "Not delivered"} className="text-danger">
        <WarningCircle size={13} weight="fill" />
      </span>
    );
  if (m.status === "read") return <Checks size={14} className="text-sky-600" />;
  if (m.status === "delivered") return <Checks size={14} className="text-muted" />;
  return <Check size={13} className="text-muted" />;
}

function MessageList({ messages }) {
  const endRef = useRef(null);
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  let lastDay = "";
  return (
    <div className="space-y-1.5 px-4 py-4">
      {messages.map((m) => {
        const day = fmtDay(m.created_at);
        const showDay = day !== lastDay;
        lastDay = day;
        const out = m.direction === "out";
        const src = SOURCE_META[m.source];
        return (
          <div key={m.id}>
            {showDay && (
              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-white/80 px-3 py-0.5 text-[11px] text-muted shadow-card">{day}</span>
              </div>
            )}
            <div className={cn("flex", out ? "justify-end" : "justify-start")} data-testid={`msg-${m.id}`}>
              <div
                className={cn(
                  "max-w-[82%] rounded-2xl px-3 py-2 text-sm shadow-card",
                  out ? "rounded-br-sm bg-forest-50 text-ink" : "rounded-bl-sm bg-white text-ink",
                  m.status === "failed" && "ring-1 ring-danger/40"
                )}
              >
                {out && src && (
                  <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-forest">
                    <src.icon size={11} /> {src.label}
                  </div>
                )}
                {m.media_id ? (
                  <div className={m.body && m.body !== m.media_name ? "mb-1" : ""}>
                    <MessageMedia m={m} />
                  </div>
                ) : (
                  !["text", "template"].includes(m.kind) && <div className="mb-0.5 text-[11px] font-medium uppercase text-muted">[{m.kind}]</div>
                )}
                {m.kind === "template" && <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Template</div>}
                {(!m.media_id || (m.body && m.body !== m.media_name)) && (
                  <div className="whitespace-pre-wrap break-words">{m.body || (m.media_id || m.kind === "text" ? "" : "(no text)")}</div>
                )}
                <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted">
                  {fmtTime(m.created_at)}
                  {out && <StatusTick m={m} />}
                </div>
                {m.status === "failed" && m.error && <div className="mt-1 text-[11px] text-danger">{m.error}</div>}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

/* ---------- Orders panel ---------- */
function OrderEditor({ order, onSaved, onConfirm }) {
  const [form, setForm] = useState(order);
  const [saving, setSaving] = useState(false);
  const dirty = ORDER_FIELDS.some((k) => (form[k] || "") !== (order[k] || ""));
  // The thread refreshes every few seconds with fresh objects. Only take the
  // server's values when they really changed, and never over unsaved typing.
  const serverKey = ORDER_FIELDS.map((k) => order[k] || "").join("\u0000");
  const lastKey = useRef(serverKey);
  useEffect(() => {
    if (serverKey === lastKey.current) return;
    lastKey.current = serverKey;
    if (!dirty) setForm(order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const save = async () => {
    setSaving(true);
    try {
      await updateOrder(order.id, {
        order_id: form.order_id,
        product_name: form.product_name,
        charm: form.charm,
        notes: form.notes,
      });
      toast.success("Order saved");
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-line bg-white p-3" data-testid={`order-card-${order.id}`}>
      <div className="flex items-center justify-between gap-2">
        <SourceBadge source={order.source} />
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-forest"
          onClick={() => {
            navigator.clipboard?.writeText(form.order_id || "");
            toast.success("Order ID copied");
          }}
          data-testid={`order-copy-${order.id}`}
        >
          <Copy size={12} /> Copy ID
        </button>
      </div>
      {[
        ["order_id", "Order ID", "font-mono"],
        ["product_name", "Name on product", ""],
        ["charm", "Charm", ""],
        ["notes", "Notes", ""],
      ].map(([k, l, cls]) => (
        <div key={k} className="space-y-1">
          <Label className="text-[10px]">{l}</Label>
          <Input
            data-testid={`order-${order.id}-${k}`}
            value={form[k] || ""}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            className={cn("h-8 text-sm", cls)}
          />
        </div>
      ))}
      {dirty && (
        <Button size="sm" className="w-full" disabled={saving} onClick={save} data-testid={`order-save-${order.id}`}>
          {saving ? <Spinner /> : <FloppyDisk size={14} />} Save changes
        </Button>
      )}
      {onConfirm && (
        <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
          <span className="text-[11px] text-muted" data-testid={`order-confirmed-${order.id}`}>
            {order.confirmed_at ? (
              <span className="inline-flex items-center gap-1 text-forest">
                <SealCheck size={13} weight="fill" /> Confirmed {timeAgo(order.confirmed_at)}
              </span>
            ) : (
              "Not confirmed yet"
            )}
          </span>
          <Button size="sm" variant="outline" disabled={dirty} title={dirty ? "Save your changes first" : ""} onClick={() => onConfirm(order)} data-testid={`order-confirm-${order.id}`}>
            <PaperPlaneRight size={13} /> {order.confirmed_at ? "Send again" : "Send confirmation"}
          </Button>
        </div>
      )}
    </div>
  );
}

function OrdersPanel({ thread, onChanged, onConfirm }) {
  const [reading, setReading] = useState(false);
  const [adding, setAdding] = useState(false);
  const { contact, orders } = thread;

  const readAgain = async () => {
    setReading(true);
    try {
      const res = await readOrdersAgain(contact.number_label, contact.customer_phone);
      if (res.orders.length) toast.success(`Found ${res.orders.length} order${res.orders.length > 1 ? "s" : ""}`);
      else toast.info(res.ai_ready ? "No order details found in the recent messages" : "No order ID found. (AI isn't set up, so only order IDs are detected.)");
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setReading(false);
    }
  };

  const addBlank = async () => {
    setAdding(true);
    try {
      await createOrder({ customer_phone: contact.customer_phone, source: "manual", channel: contact.number_label });
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-3">
        <div className="font-heading text-sm font-bold">Order details</div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={readAgain} disabled={reading} title="Read the chat again" data-testid="orders-read-again-btn">
            {reading ? <Spinner /> : <ArrowsClockwise size={14} />} Read chat
          </Button>
          <Button size="sm" variant="ghost" onClick={addBlank} disabled={adding} title="Add an order by hand" data-testid="orders-add-btn">
            <Plus size={14} />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {orders.length === 0 ? (
          <p className="text-xs text-muted">
            No order saved for this customer yet. The bot saves one automatically when the customer sends an order ID. You can also click{" "}
            <b>Read chat</b> or <b>+</b>.
          </p>
        ) : (
          orders.map((o) => <OrderEditor key={o.id} order={o} onSaved={onChanged} onConfirm={thread.number.can_send ? onConfirm : null} />)
        )}
        <Link to="/labels" className="block text-center text-xs font-medium text-forest hover:underline">
          Stamp these on labels in Label Studio →
        </Link>
      </div>
    </div>
  );
}

/* ---------- Thread ---------- */
function Thread({ sel, onBack, onSent }) {
  const [thread, setThread] = useState(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState(null); // attachment waiting to be sent
  const [filePreview, setFilePreview] = useState("");
  const fileInput = useRef(null);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) return setFilePreview("");
    const url = URL.createObjectURL(file);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [sending, setSending] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  const [tplFor, setTplFor] = useState(null); // { order, confirmation } while the template dialog is open

  const load = useCallback(async () => {
    try {
      setThread(await getThread(sel.label, sel.phone));
    } catch (e) {
      if (e?.response?.status === 404) setThread(false);
    }
  }, [sel.label, sel.phone]);

  useEffect(() => {
    setThread(null);
    setText("");
    setFile(null);
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  if (thread === null)
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner />
      </div>
    );
  if (thread === false)
    return <EmptyState icon={ChatsTeardrop} title="Chat not found" text="This customer hasn't messaged that number yet." />;

  const { contact, messages, number } = thread;
  const left = hoursLeft(contact.window_closes_at);
  const canReply = contact.window_open && number.can_send;

  const pickFile = (f) => {
    if (!f) return;
    const limit = f.type.startsWith("image/") ? 5 : 16;
    if (f.size > limit * 1024 * 1024) return toast.error(`That file is ${fmtSize(f.size)}. WhatsApp allows up to ${limit} MB for this type.`);
    setFile(f);
  };

  const send = async (e) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body && !file) return;
    setSending(true);
    try {
      setThread(
        file
          ? await sendInboxMedia(contact.number_label, contact.customer_phone, file, body)
          : await sendInboxMessage(contact.number_label, contact.customer_phone, body)
      );
      setText("");
      setFile(null);
      onSent();
    } catch (err) {
      toast.error(errorMessage(err));
      load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line bg-white px-3 py-2.5">
          <button className="rounded-lg p-1.5 hover:bg-sand lg:hidden" onClick={onBack} aria-label="Back to chats" data-testid="chat-back-btn">
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate font-heading text-sm font-bold">{contact.name || fmtPhone(contact.customer_phone)}</div>
            <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
              <span className="font-mono">{fmtPhone(contact.customer_phone)}</span>
              <span>· via {contact.number_label}</span>
              {number.bot_mode && (
                <span>
                  · bot: {number.bot_mode === "read" ? "reads & saves orders" : number.bot_mode === "ask" ? "asks questions" : "off"}
                </span>
              )}
            </div>
          </div>
          <Badge variant={contact.window_open ? "default" : "neutral"} className="hidden sm:inline-flex" data-testid="reply-window-badge">
            <Clock size={11} /> {contact.window_open ? `Reply window ${left >= 1 ? `${Math.floor(left)}h` : `${Math.ceil(left * 60)}m`} left` : "Reply window closed"}
          </Badge>
          <Button size="sm" variant="outline" className="xl:hidden" onClick={() => setShowOrders((v) => !v)} data-testid="toggle-orders-btn">
            <Package size={14} /> {thread.orders.length}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#EFEAE1]">
          <MessageList messages={messages} />
        </div>

        <form onSubmit={send} className="border-t border-line bg-white p-3" data-testid="reply-form">
          {!number.can_send ? (
            <p className="text-xs text-muted">This number is paused or not set up for sending. Check Settings → WhatsApp numbers.</p>
          ) : !contact.window_open ? (
            <div className="flex flex-wrap items-center justify-between gap-2" data-testid="window-closed-note">
              <p className="text-xs text-muted">
                Typed replies only work within 24 hours of the customer's last message. To message them now, send an approved template.
              </p>
              <Button size="sm" onClick={() => setTplFor({ order: null, confirmation: false })} type="button" data-testid="open-template-btn">
                <FileText size={14} /> Send template
              </Button>
            </div>
          ) : null}
          {file && (
            <div className="mb-2 flex items-center gap-3 rounded-lg border border-line bg-cream/60 p-2" data-testid="attachment-chip">
              {filePreview ? (
                <img src={filePreview} alt="" className="h-12 w-12 rounded object-cover" />
              ) : (
                <FileText size={28} className="text-forest" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{file.name}</div>
                <div className="text-xs text-muted">
                  {fmtSize(file.size)} · {file.type.startsWith("audio/") ? "voice notes and audio can't have a caption" : "the text box is the caption"}
                </div>
              </div>
              <button type="button" className="rounded-md p-1 text-muted hover:bg-sand" onClick={() => setFile(null)} aria-label="Remove attachment" data-testid="attachment-remove">
                <X size={16} />
              </button>
            </div>
          )}
          <div className="mt-1 flex items-end gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,application/pdf,text/plain,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
              data-testid="attach-input"
            />
            {canReply && (
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} title="Attach a photo or file" aria-label="Attach a photo or file" data-testid="attach-btn">
                <Paperclip size={16} />
              </Button>
            )}
            <Textarea
              data-testid="reply-input"
              rows={1}
              onPaste={(e) => {
                const f = [...(e.clipboardData?.files || [])][0];
                if (f && canReply) {
                  e.preventDefault();
                  pickFile(f);
                }
              }}
              placeholder={
                canReply
                  ? file
                    ? "Add a caption (optional)…"
                    : "Type a reply… (Enter to send, Shift+Enter for a new line)"
                  : "Replies are disabled for this chat"
              }
              disabled={!canReply || sending}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              className="max-h-40 min-h-[42px] resize-none"
            />
            {canReply && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setTplFor({ order: null, confirmation: false })}
                title="Send a template"
                aria-label="Send a template"
                data-testid="template-btn"
              >
                <FileText size={16} />
              </Button>
            )}
            <Button type="submit" disabled={!canReply || sending || (!text.trim() && !file)} data-testid="reply-send-btn" aria-label="Send">
              {sending ? <Spinner /> : <PaperPlaneRight size={16} weight="fill" />}
            </Button>
          </div>
        </form>
      </div>

      {/* Orders: side panel on wide screens, toggle on smaller ones */}
      <aside className={cn("w-80 shrink-0 border-l border-line bg-cream/60", showOrders ? "block" : "hidden xl:block")}>
        <OrdersPanel thread={thread} onChanged={load} onConfirm={(o) => setTplFor({ order: o, confirmation: true })} />
      </aside>

      <TemplateDialog
        open={!!tplFor}
        onClose={() => setTplFor(null)}
        numberLabel={contact.number_label}
        phone={contact.customer_phone}
        contactName={contact.name}
        orders={thread.orders}
        order={tplFor?.order || null}
        confirmation={!!tplFor?.confirmation}
        onSent={(res) => {
          if (res?.contact && res.contact.number_label === contact.number_label) setThread(res);
          else load();
          onSent();
        }}
      />
    </div>
  );
}

/* ---------- Page ---------- */
export default function Chats() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [number, setNumber] = useState("");
  const [numbers, setNumbers] = useState([]);
  const sel = useMemo(() => (params.get("phone") && params.get("number") ? { label: params.get("number"), phone: params.get("phone") } : null), [params]);

  const load = useCallback(async () => {
    try {
      setItems(await getConversations(query.trim(), number));
    } catch (e) {
      /* keep the last list while polling */
    } finally {
      setLoading(false);
    }
  }, [query, number]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    const i = setInterval(load, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [load]);

  useEffect(() => {
    waNumbers()
      .then((list) => setNumbers(list))
      .catch(() => {});
  }, []);

  const select = (s) => setParams(s ? { number: s.label, phone: s.phone } : {}, { replace: false });

  return (
    <div className="-mx-4 -my-6 sm:-mx-6 lg:-mx-10 lg:-my-10">
      <div className="flex h-[calc(100vh-57px)] min-h-[480px] overflow-hidden border-line bg-white lg:h-screen">
        <div className={cn("w-full shrink-0 border-r border-line lg:w-80", sel ? "hidden lg:block" : "block")}>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h1 className="font-heading text-lg font-extrabold">Chats</h1>
            {numbers.length === 0 && (
              <Link to="/settings?tab=whatsapp" className="text-xs font-medium text-forest hover:underline">
                Add a number
              </Link>
            )}
          </div>
          <div className="h-[calc(100%-53px)]">
            <ConversationList
              items={items}
              loading={loading}
              selected={sel}
              onSelect={select}
              query={query}
              setQuery={setQuery}
              numbers={numbers}
              number={number}
              setNumber={setNumber}
            />
          </div>
        </div>
        <div className={cn("min-w-0 flex-1", sel ? "block" : "hidden lg:block")}>
          {sel ? (
            <Thread key={`${sel.label}|${sel.phone}`} sel={sel} onBack={() => select(null)} onSent={load} />
          ) : (
            <div className="grid h-full place-items-center p-6">
              <EmptyState
                icon={ChatsTeardrop}
                title="Pick a chat"
                text="Search by phone, customer name, order ID or anything they wrote. The bot shows the order details it read next to each chat."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
