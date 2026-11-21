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
  Info,
  Archive,
  PushPin,
  BellSlash,
} from "@phosphor-icons/react";
import {
  getConversations,
  getThread,
  sendInboxMessage,
  sendInboxMedia,
  readOrdersAgain,
  deleteChat,
  getUnread,
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
import ContactInfo, { Avatar, fmtPhone } from "../components/ContactInfo";
import ChatMenu from "../components/ChatMenu";

const ORDER_FIELDS = ["order_id", "product_name", "colour", "charm", "quantity", "notes"];
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
// Like a phone chat app: "14:05" today, "Yesterday", the weekday this week, then the date.
function listTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (days <= 0) return fmtTime(iso);
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}
// Web links in messages open in a new tab (as text only: never rendered as HTML).
function linkify(text) {
  return text.split(/(\bhttps?:\/\/[^\s<>"')]+)/gi).map((part, i) =>
    i % 2 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-[#027EB5] hover:underline">
        {part}
      </a>
    ) : (
      part
    )
  );
}
function dayLabel(iso) {
  const days = Math.round((dayStart(new Date()) - dayStart(new Date(iso))) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return fmtDay(iso);
}

function hoursLeft(iso) {
  if (!iso) return 0;
  return Math.max(0, (new Date(iso).getTime() - Date.now()) / 3600000);
}

/* ---------- Conversation list ---------- */
function ConversationList({
  items, loading, selected, onSelect, query, setQuery, numbers, number, setNumber,
  archivedView, setArchivedView, archivedInfo, onChatChanged, onChatDeleted,
}) {
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
        {archivedView ? (
          <button
            type="button"
            onClick={() => setArchivedView(false)}
            className="flex w-full items-center gap-4 border-b border-[#E9EDEF] px-4 py-3 text-left text-[15px] font-medium text-[#111b21] hover:bg-[#F5F6F6]"
            data-testid="archived-back"
          >
            <ArrowLeft size={18} className="text-[#54656F]" /> Archived
          </button>
        ) : (
          !query &&
          archivedInfo.archived > 0 && (
            <button
              type="button"
              onClick={() => setArchivedView(true)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-[#F5F6F6]"
              data-testid="archived-row"
            >
              <span className="grid w-[46px] place-items-center">
                <Archive size={20} className="text-[#1DAA61]" />
              </span>
              <span className="flex-1 text-[15px] text-[#111b21]">Archived</span>
              <span className={cn("text-[12px]", archivedInfo.archived_unread ? "font-medium text-[#1DAA61]" : "text-muted")}>
                {archivedInfo.archived_unread || archivedInfo.archived}
              </span>
            </button>
          )
        )}
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-10 text-muted">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">
            {query ? "No chats match your search." : archivedView ? "No archived chats." : "No chats yet."}
          </p>
        ) : (
          items.map((c) => {
            const active = selected && selected.label === c.number_label && selected.phone === c.customer_phone;
            return (
              <div
                key={`${c.number_label}|${c.customer_phone}`}
                role="button"
                tabIndex={0}
                data-testid={`chat-item-${c.customer_phone}`}
                onClick={() => onSelect({ label: c.number_label, phone: c.customer_phone })}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && onSelect({ label: c.number_label, phone: c.customer_phone })}
                className={cn("group flex w-full cursor-pointer items-center gap-3 pl-3 text-left transition-colors", active ? "bg-[#F0F2F5]" : "hover:bg-[#F5F6F6]")}
              >
                <Avatar name={c.name} phone={c.customer_phone} size={46} />
                <div className="min-w-0 flex-1 border-b border-[#E9EDEF] py-3 pr-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[15px] text-[#111b21]">{c.name || fmtPhone(c.customer_phone)}</span>
                    <span className={cn("shrink-0 text-[11px]", c.unread > 0 ? "font-medium text-[#1DAA61]" : "text-muted")}>{listTime(c.last_message_at)}</span>
                  </div>
                  {c.name && <div className="truncate font-mono text-[11px] text-muted">{fmtPhone(c.customer_phone)}</div>}
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[#667781]">{c.last_preview}</span>
                    {c.muted && <BellSlash size={15} className="shrink-0 text-[#8696A0]" aria-label="Muted" />}
                    {c.pinned_at && !c.archived && <PushPin size={15} weight="fill" className="shrink-0 text-[#8696A0]" aria-label="Pinned" />}
                    {c.unread > 0 && (
                      <span
                        className={cn(
                          "grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold text-white",
                          c.muted ? "bg-[#C2C7CA]" : "bg-[#25D366]"
                        )}
                      >
                        {c.unread}
                      </span>
                    )}
                    <ChatMenu
                      chat={c}
                      onChanged={onChatChanged}
                      onDeleted={() => onChatDeleted(c)}
                      onMarkedUnread={active ? () => onSelect(null) : undefined}
                    />
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
              </div>
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
  if (m.status === "read") return <Checks size={16} weight="bold" className="text-[#53BDEB]" />;
  if (m.status === "delivered") return <Checks size={16} weight="bold" className="text-[#8696A0]" />;
  return <Check size={15} weight="bold" className="text-[#8696A0]" />;
}

// Messages from the same side (and same sender) within a few minutes are grouped: only the first gets a tail.
const sameGroup = (a, b) =>
  a && b && a.direction === b.direction && a.source === b.source && fmtDay(a.created_at) === fmtDay(b.created_at) &&
  new Date(b.created_at) - new Date(a.created_at) < 5 * 60 * 1000;

function MessageList({ messages, namePrefix }) {
  const endRef = useRef(null);
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  let lastDay = "";
  return (
    <div className="px-[4%] py-3 sm:px-[6%]">
      {messages.map((m, i) => {
        const day = fmtDay(m.created_at);
        const showDay = day !== lastDay;
        lastDay = day;
        const out = m.direction === "out";
        const src = SOURCE_META[m.source];
        const first = !sameGroup(messages[i - 1], m);
        return (
          <div key={m.id} className={first ? "mt-3" : "mt-0.5"}>
            {showDay && (
              <div className="my-3 flex justify-center">
                <span className="rounded-lg bg-white px-3 py-1 text-[12.5px] text-[#54656F] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">{dayLabel(m.created_at)}</span>
              </div>
            )}
            <div className={cn("flex", out ? "justify-end pr-2" : "justify-start pl-2")} data-testid={`msg-${m.id}`}>
              <div
                className={cn(
                  "bubble max-w-[85%] sm:max-w-[65%]",
                  out ? "bubble-out" : "bubble-in",
                  first && "bubble-tail",
                  m.status === "failed" && "ring-1 ring-danger/40"
                )}
              >
                {out && src && first && (
                  <div className="mb-0.5 flex items-center gap-1 text-[12px] font-medium text-[#1F7A4D]">
                    <src.icon size={12} /> {src.label}
                  </div>
                )}
                {m.media_id ? (
                  <div className={m.body && m.body !== m.media_name ? "mb-1" : ""}>
                    <MessageMedia m={m} namePrefix={namePrefix} />
                  </div>
                ) : (
                  !["text", "template"].includes(m.kind) && <div className="mb-0.5 text-[11px] font-medium uppercase text-muted">[{m.kind}]</div>
                )}
                {m.kind === "template" && <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">Template</div>}
                {(!m.media_id || (m.body && m.body !== m.media_name)) ? (
                  <div className="whitespace-pre-wrap break-words">
                    {m.body ? linkify(m.body) : m.media_id || m.kind === "text" ? "" : "(no text)"}
                    {/* the time sits at the end of the last line, like a phone chat app */}
                    <span className="relative top-[5px] float-right ml-3 inline-flex items-center gap-0.5 whitespace-nowrap text-[11px] leading-none text-[#667781]">
                      {fmtTime(m.created_at)}
                      {out && <StatusTick m={m} />}
                    </span>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center justify-end gap-0.5 text-[11px] leading-none text-[#667781]">
                    {fmtTime(m.created_at)}
                    {out && <StatusTick m={m} />}
                  </div>
                )}
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
        colour: form.colour || "",
        charm: form.charm,
        quantity: form.quantity || "",
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
        ["colour", "Colour", ""],
        ["charm", "Charm", ""],
        ["quantity", "Quantity", ""],
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

function OrdersPanel({ thread, onChanged, onConfirm, onClose }) {
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
      <div className="flex h-[59px] shrink-0 items-center justify-between gap-2 border-b border-line bg-[#F0F2F5] px-3">
        <div className="flex items-center gap-2">
          {onClose && (
            <button type="button" onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-black/5" aria-label="Close order details" data-testid="orders-close">
              <X size={18} />
            </button>
          )}
          <div className="text-[15px] font-medium text-ink">Order details</div>
        </div>
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
function Thread({ sel, onBack, onSent, onDeleted }) {
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
  const [panel, setPanel] = useState(null); // null (orders on wide screens) | "orders" | "info"
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
  const lateReply = !contact.window_open && !!number.late_reply; // typed replies go out as the late-reply template
  const canReply = number.can_send && (contact.window_open || lateReply);

  const pickFile = (f) => {
    if (!f) return;
    const limit = f.type.startsWith("image/") ? 5 : 16;
    if (f.size > limit * 1024 * 1024) return toast.error(`That file is ${fmtSize(f.size)}. WhatsApp allows up to ${limit} MB for this type.`);
    setFile(f);
  };

  const removeChat = async () => {
    try {
      const r = await deleteChat(contact.number_label, contact.customer_phone);
      toast.success(`Chat deleted (${r.messages} message${r.messages === 1 ? "" : "s"}). Orders were kept.`);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete this chat"));
    }
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
      if (!file && lateReply) toast.success(`Sent as the "${number.late_reply}" template`);
    } catch (err) {
      toast.error(errorMessage(err));
      load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[59px] shrink-0 items-center gap-2 border-b border-line bg-[#F0F2F5] px-3">
          <button className="rounded-full p-1.5 text-[#54656F] hover:bg-black/5 lg:hidden" onClick={onBack} aria-label="Back to chats" data-testid="chat-back-btn">
            <ArrowLeft size={20} />
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            onClick={() => setPanel((p) => (p === "info" ? null : "info"))}
            title="Contact info"
            data-testid="chat-header-profile"
          >
            <Avatar name={contact.name} phone={contact.customer_phone} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[16px] text-[#111b21]">{contact.name || fmtPhone(contact.customer_phone)}</div>
              <div className="truncate text-[12.5px] text-[#667781]">
                {contact.name ? `${fmtPhone(contact.customer_phone)} · ` : ""}via {contact.number_label}
                {number.bot_mode && ` · bot: ${number.bot_mode === "read" ? "reads & saves orders" : number.bot_mode === "ask" ? "asks questions" : "off"}`}
                <span className="hidden md:inline"> · click for contact info</span>
              </div>
            </div>
          </button>
          <Badge
            variant={contact.window_open ? "default" : "neutral"}
            className={cn("hidden shrink-0", panel === "info" ? "2xl:inline-flex" : "sm:inline-flex")}
            data-testid="reply-window-badge"
          >
            <Clock size={11} /> {contact.window_open ? `Reply window ${left >= 1 ? `${Math.floor(left)}h` : `${Math.ceil(left * 60)}m`} left` : "Reply window closed"}
          </Badge>
          <button
            type="button"
            className={cn("relative rounded-full p-2 text-[#54656F] hover:bg-black/5", panel === "orders" && "bg-black/5")}
            onClick={() => setPanel((p) => (p === "orders" ? null : "orders"))}
            title="Order details"
            aria-label="Order details"
            data-testid="toggle-orders-btn"
          >
            <Package size={21} />
            {thread.orders.length > 0 && (
              <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-forest px-1 text-[9px] font-bold text-white">{thread.orders.length}</span>
            )}
          </button>
          <button
            type="button"
            className={cn("rounded-full p-2 text-[#54656F] hover:bg-black/5", panel === "info" && "bg-black/5")}
            onClick={() => setPanel((p) => (p === "info" ? null : "info"))}
            title="Contact info"
            aria-label="Contact info"
            data-testid="contact-info-btn"
          >
            <Info size={21} />
          </button>
        </div>

        <div className="chat-wallpaper min-h-0 flex-1 overflow-y-auto">
          <MessageList messages={messages} namePrefix={thread.orders[0]?.order_id || ""} />
        </div>

        <form onSubmit={send} className="bg-[#F0F2F5] px-3 py-2.5" data-testid="reply-form">
          {!number.can_send ? (
            <p className="text-xs text-muted">This number is paused or not set up for sending. Check Settings → WhatsApp numbers.</p>
          ) : lateReply ? (
            <div className="flex flex-wrap items-center justify-between gap-2" data-testid="late-reply-note">
              <p className="text-xs text-muted">
                The 24-hour window has closed, so your reply will be sent as the <b>{number.late_reply}</b> template (small Meta fee), with the
                customer's name and order filled in. Photos and files need an open window.
              </p>
              <Button size="sm" variant="outline" onClick={() => setTplFor({ order: null, confirmation: false })} type="button" data-testid="open-template-btn">
                <FileText size={14} /> Other template
              </Button>
            </div>
          ) : !contact.window_open ? (
            <div className="flex flex-wrap items-center justify-between gap-2" data-testid="window-closed-note">
              <p className="text-xs text-muted">
                Typed replies only work within 24 hours of the customer's last message. Send an approved template, or set one up for late
                replies: open Send template, set a blank to "Your message" and tick "Use for replies after 24 hours".
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
            {canReply && !lateReply && (
              <button type="button" className="mb-1 rounded-full p-2 text-[#54656F] hover:bg-black/5" onClick={() => fileInput.current?.click()} title="Attach a photo or file" aria-label="Attach a photo or file" data-testid="attach-btn">
                <Paperclip size={22} />
              </button>
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
                    : lateReply
                      ? `Type a reply… (sent as the "${number.late_reply}" template)`
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
              className="max-h-40 min-h-[42px] resize-none rounded-lg border-0 bg-white px-3 py-2.5 text-[15px] shadow-none focus-visible:ring-1"
            />
            {canReply && (
              <button
                type="button"
                className="mb-1 rounded-full p-2 text-[#54656F] hover:bg-black/5"
                onClick={() => setTplFor({ order: null, confirmation: false })}
                title="Send a template"
                aria-label="Send a template"
                data-testid="template-btn"
              >
                <FileText size={22} />
              </button>
            )}
            <button
              type="submit"
              disabled={!canReply || sending || (!text.trim() && !file)}
              className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-forest text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              data-testid="reply-send-btn"
              aria-label="Send"
            >
              {sending ? <Spinner /> : <PaperPlaneRight size={20} weight="fill" />}
            </button>
          </div>
        </form>
      </div>

      {/* Orders: side panel on wide screens, toggle on smaller ones */}
      {/* Orders or contact info: a side panel on wide screens, sliding over the chat on smaller ones */}
      <aside
        className={cn(
          "absolute inset-y-0 right-0 z-20 w-full shrink-0 border-l border-line bg-cream sm:w-96 xl:static xl:z-auto",
          panel === "info" ? "xl:w-[400px]" : "xl:w-80",
          panel ? "block" : "hidden xl:block"
        )}
      >
        {panel === "info" ? (
          <ContactInfo
            thread={thread}
            onClose={() => setPanel(null)}
            onShowOrders={() => setPanel("orders")}
            onTemplate={() => setTplFor({ order: null, confirmation: false })}
            onDelete={removeChat}
          />
        ) : (
          <OrdersPanel
            thread={thread}
            onChanged={load}
            onConfirm={(o) => setTplFor({ order: o, confirmation: true })}
            onClose={panel === "orders" ? () => setPanel(null) : null}
          />
        )}
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
        message={text}
        onSent={(res) => {
          if (res?.contact && res.contact.number_label === contact.number_label) {
            setThread(res);
            setText(""); // the typed text may have gone out as the template's message
          } else load();
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
  const [archivedView, setArchivedView] = useState(false);
  const [archivedInfo, setArchivedInfo] = useState({ archived: 0, archived_unread: 0 });
  const sel = useMemo(() => (params.get("phone") && params.get("number") ? { label: params.get("number"), phone: params.get("phone") } : null), [params]);

  const load = useCallback(async () => {
    try {
      const [list, counts] = await Promise.all([getConversations(query.trim(), number, archivedView), getUnread()]);
      setItems(list);
      setArchivedInfo(counts);
    } catch (e) {
      /* keep the last list while polling */
    } finally {
      setLoading(false);
    }
  }, [query, number, archivedView]);

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
  const sameChat = (a, b) => a.number_label === b.number_label && a.customer_phone === b.customer_phone;
  const chatChanged = (updated) => {
    // show the change straight away (a chat archived/unarchived leaves this list), then refresh from the server
    const pinned = (x) => (x.pinned_at && !x.archived ? 1 : 0);
    setItems((list) =>
      list
        .map((x) => (sameChat(x, updated) ? { ...x, ...updated } : x))
        .filter((x) => query.trim() || !!x.archived === archivedView)
        .sort((a, b) => pinned(b) - pinned(a) || (b.pinned_at || "").localeCompare(a.pinned_at || "") || b.last_message_at.localeCompare(a.last_message_at))
    );
    load();
  };
  const chatDeleted = (c) => {
    setItems((list) => list.filter((x) => !sameChat(x, c)));
    if (sel && sel.label === c.number_label && sel.phone === c.customer_phone) select(null);
    load();
  };

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
              archivedView={archivedView}
              setArchivedView={(v) => {
                setLoading(true);
                setItems([]);
                setArchivedView(v);
              }}
              archivedInfo={archivedInfo}
              onChatChanged={chatChanged}
              onChatDeleted={chatDeleted}
            />
          </div>
        </div>
        <div className={cn("min-w-0 flex-1", sel ? "block" : "hidden lg:block")}>
          {sel ? (
            <Thread key={`${sel.label}|${sel.phone}`} sel={sel} onBack={() => select(null)} onSent={load} onDeleted={() => {
                select(null);
                load();
              }} />
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
