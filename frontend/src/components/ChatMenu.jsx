import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  DotsThreeVertical,
  Archive,
  ArrowUUpLeft,
  BellSlash,
  Bell,
  PushPin,
  PushPinSlash,
  ChatCircleDots,
  CheckCircle,
  Eraser,
  Trash,
  Export,
  AddressBook,
} from "@phosphor-icons/react";
import { ConfirmDialog } from "./ui/overlays";
import ExportChatDialog from "./ExportChatDialog";
import { setChatState, clearChat, deleteChat, errorMessage } from "../lib/api";
import { cn } from "../lib/utils";

const fmtPhone = (p) => (p ? `+${p}` : "");
const MENU_W = 216;

/** The ⋮ menu on a chat in the list: archive, mute, pin, read/unread, clear, delete. */
export default function ChatMenu({ chat, onChanged, onDeleted, onMarkedUnread }) {
  const [pos, setPos] = useState(null); // where the open menu sits (fixed, so the list's scroll never cuts it off)
  const [confirm, setConfirm] = useState(null); // "clear" | "delete" | "export"
  const btn = useRef(null);
  const menu = useRef(null);
  const who = chat.name || fmtPhone(chat.customer_phone);

  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      if (e.type === "keydown" ? e.key === "Escape" : !menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setPos(null);
    };
    const shut = () => setPos(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", shut);
    document.addEventListener("scroll", shut, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", shut);
      document.removeEventListener("scroll", shut, true);
    };
  }, [pos]);

  const toggle = (e) => {
    e.stopPropagation();
    if (pos) return setPos(null);
    const r = btn.current.getBoundingClientRect();
    const height = 300;
    const up = r.bottom + height > window.innerHeight - 8; // near the bottom: open upwards
    setPos({ top: up ? Math.max(8, r.top - height) : r.bottom + 4, left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)) });
  };

  const change = async (state, done) => {
    setPos(null);
    try {
      if (state.unread === true && onMarkedUnread) {
        // close the chat first: an open chat marks itself read every few seconds
        onMarkedUnread();
        await new Promise((r) => setTimeout(r, 400));
      }
      const updated = await setChatState(chat.number_label, chat.customer_phone, state);
      onChanged(updated);
      if (done) toast.success(done);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const doClear = async () => {
    try {
      const r = await clearChat(chat.number_label, chat.customer_phone);
      toast.success(`Chat cleared (${r.cleared} message${r.cleared === 1 ? "" : "s"}). Orders were kept.`);
      onChanged({ ...chat, last_preview: "", unread: 0 });
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't clear this chat"));
    }
  };

  const doDelete = async () => {
    try {
      const r = await deleteChat(chat.number_label, chat.customer_phone);
      toast.success(`Chat deleted (${r.messages} message${r.messages === 1 ? "" : "s"}). Orders were kept.`);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't delete this chat"));
    }
  };

  const ask = (what) => {
    setPos(null);
    setConfirm(what);
  };

  const items = [
    chat.archived
      ? { icon: ArrowUUpLeft, label: "Unarchive chat", run: () => change({ archived: false }, "Chat unarchived") }
      : { icon: Archive, label: "Archive chat", run: () => change({ archived: true }, "Chat archived") },
    chat.muted
      ? { icon: Bell, label: "Unmute notifications", run: () => change({ muted: false }) }
      : { icon: BellSlash, label: "Mute notifications", run: () => change({ muted: true }, "Muted: not counted in unread") },
    !chat.archived &&
      (chat.pinned_at
        ? { icon: PushPinSlash, label: "Unpin chat", run: () => change({ pinned: false }) }
        : { icon: PushPin, label: "Pin chat", run: () => change({ pinned: true }) }),
    chat.unread > 0
      ? { icon: CheckCircle, label: "Mark as read", run: () => change({ unread: false }) }
      : { icon: ChatCircleDots, label: "Mark as unread", run: () => change({ unread: true }) },
    chat.saved_contact
      ? { icon: AddressBook, label: "Remove from saved contacts", run: () => change({ saved: false }, "Removed: the bot treats this number as a customer again") }
      : { icon: AddressBook, label: "Mark as saved contact", run: () => change({ saved: true }, "Saved contact: the bot won't reply or read this chat") },
    { icon: Export, label: "Export chat", run: () => ask("export") },
    { divider: true },
    { icon: Eraser, label: "Clear chat", run: () => ask("clear") },
    { icon: Trash, label: "Delete chat", danger: true, run: () => ask("delete") },
  ].filter(Boolean);

  // The menu and confirm boxes are drawn elsewhere on the page but still sit inside the chat row in React,
  // so stop their clicks here or they would also open the chat.
  const stop = (e) => e.stopPropagation();
  return (
    <span className="contents" onClick={stop} onKeyDown={stop} onMouseDown={stop}>
      <button
        ref={btn}
        type="button"
        onClick={toggle}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-full text-[#54656F] transition-opacity hover:bg-black/5",
          pos ? "bg-black/5 opacity-100" : "opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"
        )}
        aria-label={`Menu for ${who}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        data-testid={`chat-menu-${chat.customer_phone}`}
      >
        <DotsThreeVertical size={20} weight="bold" />
      </button>

      {pos &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className="fixed z-50 overflow-hidden rounded-xl border border-line bg-white py-1.5 shadow-lift"
            style={{ top: pos.top, left: pos.left, width: MENU_W }}
            onClick={(e) => e.stopPropagation()}
            data-testid="chat-menu"
          >
            {items.map((it, i) =>
              it.divider ? (
                <div key={`d${i}`} className="my-1 border-t border-line" />
              ) : (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  onClick={it.run}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left text-[14px] hover:bg-[#F5F6F6]",
                    it.danger ? "text-danger" : "text-[#111b21]"
                  )}
                  data-testid={`chat-menu-${it.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <it.icon size={18} className={it.danger ? "" : "text-[#54656F]"} />
                  {it.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}

      <ConfirmDialog
        open={confirm === "clear"}
        onOpenChange={(o) => !o && setConfirm(null)}
        testId="clear-chat"
        title="Clear this chat?"
        description={`All messages, photos and files with ${who} will be removed from Custom Label and the database for everyone on the team. This can't be undone. The chat stays in your list, you can still reply within the 24-hour window, and saved orders are kept. The customer's WhatsApp isn't affected.`}
        confirmLabel="Clear chat"
        onConfirm={doClear}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        testId="delete-chat"
        title="Delete this chat permanently?"
        description={`All messages, photos and files with ${who} will be removed from Custom Label and the database for everyone on the team, and the chat disappears from your list. Deleted chats cannot be recovered. Saved orders are kept, and the customer's own WhatsApp is not affected. If they message again, a new chat starts.`}
        confirmLabel="Delete forever"
        onConfirm={doDelete}
      />
      <ExportChatDialog
        open={confirm === "export"}
        onOpenChange={(o) => !o && setConfirm(null)}
        label={chat.number_label}
        phone={chat.customer_phone}
        who={who}
      />
    </span>
  );
}
