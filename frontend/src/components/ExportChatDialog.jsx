import { useState } from "react";
import { toast } from "sonner";
import { FileText, FileZip } from "@phosphor-icons/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/overlays";
import { Spinner } from "./ui/primitives";
import { exportChat } from "../lib/api";

async function readError(e) {
  // errors on file downloads arrive as a Blob
  if (e?.response?.data instanceof Blob) {
    try {
      return JSON.parse(await e.response.data.text()).detail;
    } catch {
      /* fall through */
    }
  }
  return "Couldn't export this chat. Try again.";
}

/** "Export chat" like WhatsApp: Without media (.txt) or Include media (.zip). */
export default function ExportChatDialog({ open, onOpenChange, label, phone, who }) {
  const [busy, setBusy] = useState(null); // "text" | "media"

  const run = async (media) => {
    setBusy(media ? "media" : "text");
    try {
      await exportChat(label, phone, media);
      toast.success(media ? "Chat exported with media" : "Chat exported");
      onOpenChange(false);
    } catch (e) {
      toast.error(await readError(e));
    } finally {
      setBusy(null);
    }
  };

  const option = (media, Icon, title, text) => (
    <button
      type="button"
      onClick={() => run(media)}
      disabled={!!busy}
      className="flex w-full items-center gap-4 rounded-xl border border-line p-4 text-left hover:bg-cream disabled:opacity-60"
      data-testid={media ? "export-with-media" : "export-without-media"}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-forest-50 text-forest">
        {busy === (media ? "media" : "text") ? <Spinner /> : <Icon size={20} />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{title}</span>
        <span className="block text-xs text-muted">{text}</span>
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Export chat</DialogTitle>
          <DialogDescription>
            Download your chat with {who} as a WhatsApp-style text file. Including media makes a bigger .zip file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          {option(false, FileText, "Without media", "One .txt file. Photos and files show as <Media omitted>.")}
          {option(
            true,
            FileZip,
            "Include media",
            "A .zip with the .txt plus photos, voice notes and files. WhatsApp keeps files for about 30 days, so older ones stay omitted."
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
