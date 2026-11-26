import { useRef, useState } from "react";
import { toast } from "sonner";
import { PaperPlaneRight, Paperclip, X, FileText, UsersThree } from "@phosphor-icons/react";
import { teamPost, teamFile, errorMessage } from "../lib/api";
import { Textarea, Spinner } from "./ui/primitives";

const MAX = 10 * 1024 * 1024;
const fmt = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Message box for a group chat: posts and files stay inside Custom Label for the team (never sent on WhatsApp). */
export default function TeamComposer({ contact, canPost, onPosted }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  if (!canPost) {
    return (
      <div className="bg-[#F0F2F5] px-4 py-3 text-center text-xs text-muted" data-testid="group-readonly-note">
        Group from the phone app: read-only for you. Ask the owner for the "Team chat" permission to post here.
      </div>
    );
  }

  const pick = (f) => {
    if (!f) return;
    if (f.size > MAX) return toast.error("That file is too big. Team files can be up to 10 MB.");
    setFile(f);
  };

  const send = async (e) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body && !file) return;
    setBusy(true);
    try {
      const thread = file
        ? await teamFile(contact.number_label, contact.customer_phone, file, body)
        : await teamPost(contact.number_label, contact.customer_phone, body);
      setText("");
      setFile(null);
      onPosted(thread);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className="bg-[#F0F2F5] px-3 py-2.5" data-testid="team-form">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-muted">
        <UsersThree size={14} className="text-[#7C4DBA]" /> Team chat: only your team sees this in Custom Label. It isn't sent on WhatsApp.
      </p>
      {file && (
        <div className="mb-2 flex items-center gap-3 rounded-lg border border-line bg-white p-2" data-testid="team-attachment">
          <FileText size={26} className="text-forest" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{file.name}</div>
            <div className="text-xs text-muted">{fmt(file.size)} · the text box is the caption</div>
          </div>
          <button type="button" className="rounded-md p-1 text-muted hover:bg-sand" onClick={() => setFile(null)} aria-label="Remove file">
            <X size={16} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={input}
          type="file"
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
          data-testid="team-file-input"
        />
        <button type="button" className="mb-1 rounded-full p-2 text-[#54656F] hover:bg-black/5" onClick={() => input.current?.click()} title="Share a file with the team" aria-label="Share a file with the team" data-testid="team-attach-btn">
          <Paperclip size={22} />
        </button>
        <Textarea
          data-testid="team-input"
          rows={1}
          value={text}
          disabled={busy}
          placeholder={file ? "Add a caption (optional)…" : "Message your team… (Enter to send, Shift+Enter for a new line)"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const f = [...(e.clipboardData?.files || [])][0];
            if (f) {
              e.preventDefault();
              pick(f);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          className="max-h-40 min-h-[42px] resize-none rounded-lg border-0 bg-white px-3 py-2.5 text-[15px] shadow-none focus-visible:ring-1"
        />
        <button
          type="submit"
          disabled={busy || (!text.trim() && !file)}
          className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-[#7C4DBA] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          aria-label="Send to team"
          data-testid="team-send-btn"
        >
          {busy ? <Spinner /> : <PaperPlaneRight size={20} weight="fill" />}
        </button>
      </div>
    </form>
  );
}
