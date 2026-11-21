import { useState } from "react";
import { toast } from "sonner";
import {
  X,
  Copy,
  WhatsappLogo,
  FileText,
  Package,
  Trash,
  Play,
  Link as LinkIcon,
  Robot,
  Clock,
  ChatCircleText,
  DeviceMobile,
  CalendarBlank,
  ImageSquare,
  CaretRight,
  Export,
} from "@phosphor-icons/react";
import { ConfirmDialog } from "./ui/overlays";
import { Spinner } from "./ui/primitives";
import { useMediaUrl } from "./MessageMedia";
import ExportChatDialog from "./ExportChatDialog";
import { cn, timeAgo } from "../lib/utils";

export const fmtPhone = (p) => (p ? `+${p}` : "");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "-");

// Soft colours for the initial-letter avatars: the same customer always gets the same colour.
const AVATAR_COLOURS = [
  ["#DFF3E4", "#1F6E43"],
  ["#FDE7D9", "#A2481F"],
  ["#E3ECFB", "#2F5597"],
  ["#F6E3F1", "#8A3477"],
  ["#FFF1C9", "#8A6100"],
  ["#E0F4F4", "#1D6B6B"],
  ["#ECE6FA", "#5B3FA3"],
];

export function Avatar({ name, phone, size = 40, className }) {
  const key = phone || name || "?";
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = AVATAR_COLOURS[h % AVATAR_COLOURS.length];
  const letter = (name || "").trim().slice(0, 1).toUpperCase() || "#";
  return (
    <div
      className={cn("grid shrink-0 select-none place-items-center rounded-full font-heading font-bold", className)}
      style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

function Section({ title, right, children, testId }) {
  return (
    <section className="bg-white px-5 py-4" data-testid={testId}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-medium text-muted">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ icon: Icon, label, value, sub }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <Icon size={18} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{value}</div>
        <div className="text-[11px] text-muted">{sub || label}</div>
      </div>
    </div>
  );
}

function Thumb({ m }) {
  const isVideo = (m.media_mime || "").startsWith("video/");
  const { url, error, loading } = useMediaUrl(m.id, !isVideo);
  const open = async () => {
    if (url) window.open(url, "_blank", "noopener");
  };
  return (
    <button
      type="button"
      onClick={open}
      disabled={!url}
      className="relative aspect-square overflow-hidden rounded-md bg-sand"
      title={error || m.media_name || "Photo"}
      data-testid={`info-media-${m.id}`}
    >
      {url && !isVideo ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted">
          {loading ? <Spinner /> : isVideo ? <Play size={22} weight="fill" /> : <ImageSquare size={22} />}
        </div>
      )}
    </button>
  );
}

function FileRow({ m }) {
  const { url, error, loading, load } = useMediaUrl(m.id, false);
  const open = async () => {
    if (url) return window.open(url, "_blank", "noopener");
    load();
  };
  return (
    <button type="button" onClick={open} className="flex w-full items-center gap-3 rounded-md px-1 py-1.5 text-left hover:bg-cream" title={error || ""}>
      <FileText size={22} className="shrink-0 text-forest" />
      <span className="min-w-0 flex-1 truncate text-sm">{m.media_name || m.kind}</span>
      {loading ? <Spinner /> : <span className="text-[11px] text-muted">{url ? "Open" : error ? "Unavailable" : fmtDate(m.created_at)}</span>}
    </button>
  );
}

export default function ContactInfo({ thread, onClose, onShowOrders, onTemplate, onDelete }) {
  const { contact, messages, number, orders } = thread;
  const stats = thread.stats || {};
  const name = contact.name || "";
  const phone = contact.customer_phone;
  const media = messages.filter((m) => m.media_id).reverse();
  const visual = media.filter((m) => /^(image|video)\//.test(m.media_mime || "")).slice(0, 9);
  const files = media.filter((m) => !/^(image|video)\//.test(m.media_mime || "")).slice(0, 5);
  const links = [...new Set(messages.flatMap((m) => (m.body || "").match(URL_RE) || []))].reverse().slice(0, 5);
  const left = contact.window_closes_at ? Math.max(0, (new Date(contact.window_closes_at) - Date.now()) / 3600000) : 0;
  const bot = number.exists
    ? { read: "Reads chats and saves orders", ask: "Asks the customer questions", off: "Off" }[number.bot_mode] || "Off"
    : "This number isn't set up in Settings any more";

  const [exporting, setExporting] = useState(false);
  const copy = (text, what) => {
    navigator.clipboard?.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#F0F2F5]" data-testid="contact-info">
      <div className="flex h-[59px] shrink-0 items-center gap-4 border-b border-line bg-[#F0F2F5] px-4">
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-black/5" aria-label="Close contact info" data-testid="contact-info-close">
          <X size={20} />
        </button>
        <span className="text-[15px] font-medium text-ink">Contact info</span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-6">
        <section className="flex flex-col items-center bg-white px-5 pb-5 pt-7 text-center">
          <Avatar name={name} phone={phone} size={120} />
          <div className="mt-4 text-[22px] font-normal leading-tight text-ink" data-testid="contact-info-name">
            {name || fmtPhone(phone)}
          </div>
          <div className="mt-1 font-mono text-[15px] text-muted">{fmtPhone(phone)}</div>
          {name && <div className="mt-0.5 text-[11px] text-muted">Name from the customer's WhatsApp profile</div>}
          <div className="mt-5 grid w-full grid-cols-4 gap-2">
            {[
              { icon: Copy, label: "Copy", onClick: () => copy(fmtPhone(phone), "Number"), testId: "info-copy" },
              { icon: WhatsappLogo, label: "WhatsApp", href: `https://wa.me/${phone}`, testId: "info-wa" },
              { icon: FileText, label: "Template", onClick: onTemplate, disabled: !number.can_send, testId: "info-template" },
              { icon: Package, label: `Orders (${orders.length})`, onClick: onShowOrders, testId: "info-orders" },
            ].map((a) => {
              const cls =
                "flex flex-col items-center gap-1.5 rounded-lg border border-line px-1 py-2.5 text-[11px] text-forest hover:bg-cream disabled:opacity-40";
              return a.href ? (
                <a key={a.label} href={a.href} target="_blank" rel="noopener noreferrer" className={cls} data-testid={a.testId} title="Open this chat in your own WhatsApp app">
                  <a.icon size={20} />
                  {a.label}
                </a>
              ) : (
                <button key={a.label} type="button" onClick={a.onClick} disabled={a.disabled} className={cls} data-testid={a.testId}>
                  <a.icon size={20} />
                  {a.label}
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-[11px] leading-snug text-muted">
            WhatsApp doesn't share customers' profile photos, About or last seen with business apps, so those can't be shown here.
          </p>
        </section>

        <Section title="This chat" testId="info-chat">
          <Row icon={DeviceMobile} label="Business number" value={contact.number_label} />
          <Row icon={Robot} label="Bot on this number" value={bot} />
          <Row
            icon={Clock}
            label="Reply window"
            value={contact.window_open ? `Open: ${left >= 1 ? `${Math.floor(left)}h` : `${Math.ceil(left * 60)}m`} left for typed replies` : "Closed: send a template"}
          />
          <Row icon={CalendarBlank} label="First message" value={fmtDate(stats.first_message_at)} />
          <Row
            icon={ChatCircleText}
            label="Messages"
            value={`${stats.messages ?? messages.length} in total, ${stats.from_customer ?? "-"} from the customer`}
            sub={contact.last_inbound_at ? `Customer last wrote ${timeAgo(contact.last_inbound_at)}` : "Messages"}
          />
        </Section>

        <Section
          title={`Media and files${stats.photos != null ? ` · ${stats.photos + stats.files}` : ""}`}
          testId="info-media"
        >
          {visual.length === 0 && files.length === 0 ? (
            <p className="text-xs text-muted">No photos, videos or files in this chat yet.</p>
          ) : (
            <>
              {visual.length > 0 && (
                <div className="grid grid-cols-3 gap-1.5">
                  {visual.map((m) => (
                    <Thumb key={m.id} m={m} />
                  ))}
                </div>
              )}
              {files.length > 0 && (
                <div className={visual.length ? "mt-3" : ""}>
                  {files.map((m) => (
                    <FileRow key={m.id} m={m} />
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted">WhatsApp keeps files for about 30 days; older ones may be unavailable.</p>
            </>
          )}
        </Section>

        {links.length > 0 && (
          <Section title={`Links · ${links.length}`} testId="info-links">
            {links.map((u) => (
              <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-2 py-1 text-sm text-[#027EB5] hover:underline">
                <LinkIcon size={15} className="shrink-0" />
                <span className="truncate">{u}</span>
              </a>
            ))}
          </Section>
        )}

        <Section
          title={`Orders · ${orders.length}`}
          right={
            <button type="button" onClick={onShowOrders} className="inline-flex items-center text-xs font-medium text-forest hover:underline" data-testid="info-edit-orders">
              Edit <CaretRight size={12} />
            </button>
          }
          testId="info-orders-list"
        >
          {orders.length === 0 ? (
            <p className="text-xs text-muted">No order saved for this customer yet.</p>
          ) : (
            <div className="divide-y divide-line">
              {orders.slice(0, 5).map((o) => (
                <button key={o.id} type="button" onClick={() => copy(o.order_id || "", "Order ID")} className="flex w-full items-center gap-3 py-2 text-left" title="Copy order ID">
                  <Package size={18} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px]">{o.order_id || "(no order ID)"}</div>
                    <div className="truncate text-[11px] text-muted">{[o.product_name, o.colour, o.charm && `Charm ${o.charm}`, o.quantity && o.quantity !== "1" && `Qty ${o.quantity}`, o.notes].filter(Boolean).join(" · ") || "No details yet"}</div>
                  </div>
                  {o.confirmed_at && <span className="text-[10px] font-medium text-forest">Confirmed</span>}
                </button>
              ))}
            </div>
          )}
        </Section>

        <button
          type="button"
          onClick={() => setExporting(true)}
          className="flex w-full items-center gap-4 bg-white px-5 py-4 text-left text-[15px] text-ink hover:bg-cream"
          data-testid="info-export-chat"
        >
          <Export size={20} className="text-muted" /> Export chat
        </button>
        <ExportChatDialog open={exporting} onOpenChange={setExporting} label={contact.number_label} phone={phone} who={name || fmtPhone(phone)} />

        <ConfirmDialog
          testId="delete-chat"
          title="Delete this chat permanently?"
          description={`All ${stats.messages ?? messages.length} message${(stats.messages ?? messages.length) === 1 ? "" : "s"}, photos and files with ${
            name || fmtPhone(phone)
          } will be removed from Charm.Studio and the database for everyone on the team. Deleted chats cannot be recovered. Saved orders are kept, and the customer's own WhatsApp is not affected. If they message again, a new chat starts.`}
          confirmLabel="Delete forever"
          onConfirm={onDelete}
          trigger={
            <button type="button" className="flex w-full items-center gap-4 bg-white px-5 py-4 text-left text-[15px] text-danger hover:bg-red-50" data-testid="delete-chat-btn">
              <Trash size={20} /> Delete chat
            </button>
          }
        />
      </div>
    </div>
  );
}
