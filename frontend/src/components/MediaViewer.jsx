import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { X, CaretLeft, CaretRight, DownloadSimple, Copy, MagnifyingGlassPlus, MagnifyingGlassMinus, Play, ImageBroken } from "@phosphor-icons/react";
import { loadUrl, downloadName, saveAs } from "./MessageMedia";
import { Spinner } from "./ui/primitives";

const isViewable = (m) => m.media_id && ["image", "sticker", "video"].includes(m.kind);
export { isViewable };

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Loads one message's file as a blob: URL (cached for the session). */
function useUrl(m) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl("");
    setFailed(false);
    if (!m) return undefined;
    loadUrl(m.id).then((u) => live && setUrl(u), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [m]);
  return { url, failed };
}

function Thumb({ m, active, onClick }) {
  const { url } = useUrl(m.kind === "video" ? null : m);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 ${active ? "border-[#00A884]" : "border-transparent opacity-60 hover:opacity-100"}`}
      data-testid={`viewer-thumb-${m.id}`}
      aria-label="Show this picture"
    >
      {m.kind === "video" ? (
        <span className="grid h-full w-full place-items-center bg-white/10 text-white"><Play size={18} weight="fill" /></span>
      ) : url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="grid h-full w-full place-items-center bg-white/10" />
      )}
    </button>
  );
}

/** Copy an image to the clipboard (as PNG, the format browsers accept). */
async function copyImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
}

/**
 * Full-screen viewer for chat photos and videos, like WhatsApp: next / previous (arrows, ← →), zoom (click,
 * scroll, + / −) with drag to move, download, copy, the screenshot reading with a Copy ID button, and
 * a strip of every picture in the chat. Esc or ✕ closes it.
 */
export default function MediaViewer({ items, startId, contactName, namePrefix = "", onClose }) {
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((m) => m.id === startId)));
  const m = items[index];
  const { url, failed } = useUrl(m);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef(null);
  const moved = useRef(false);
  const stripRef = useRef(null);

  const go = useCallback((d) => setIndex((i) => Math.min(items.length - 1, Math.max(0, i + d))), [items.length]);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    stripRef.current?.querySelector(`[data-testid="viewer-thumb-${m?.id}"]`)?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [m?.id]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(4, z + 0.5));
      else if (e.key === "-") setZoom((z) => Math.max(1, z - 0.5));
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [go, onClose]);
  useEffect(() => {
    if (zoom === 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  if (!m) return null;
  const out = m.direction === "out";
  const who = out ? (m.source === "team" ? `Team · ${m.sender || ""}` : m.source === "bot" ? "Bot" : "You") : m.sender_name || (m.sender ? `+${m.sender}` : contactName || "Customer");
  const note = m.ai_note?.startsWith("\u{1F4F7}") ? m.ai_note.replace("\u{1F4F7} ", "") : "";
  const noteId = (note.match(/Order ID\s+((?:OD)?\d[\d_]*)/i) || [])[1];

  const download = async () => {
    try {
      saveAs(url || (await loadUrl(m.id)), downloadName(m, namePrefix));
    } catch {
      toast.error("Couldn't download this file");
    }
  };
  const copy = async () => {
    try {
      await copyImage(url);
      toast.success("Picture copied");
    } catch {
      toast.error("Your browser didn't allow copying the picture. Use Download instead.");
    }
  };

  const onWheel = (e) => {
    if (m.kind === "video") return;
    setZoom((z) => Math.min(4, Math.max(1, z + (e.deltaY < 0 ? 0.25 : -0.25))));
  };
  const onDown = (e) => {
    moved.current = false;
    if (zoom > 1) drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };
  const onMove = (e) => {
    if (!drag.current) return;
    moved.current = true;
    setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
  };
  const onUp = () => {
    drag.current = null;
  };
  const onImageClick = () => {
    if (moved.current) return; // that was a drag
    setZoom((z) => (z > 1 ? 1 : 2));
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-[#0b141a]/95 text-white" role="dialog" aria-modal="true" aria-label="Picture viewer" data-testid="media-viewer">
      {/* top bar: who sent it and when, then the tools */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium" data-testid="viewer-sender">{who}</div>
          <div className="text-xs text-white/60">{fmtWhen(m.created_at)}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}</div>
        </div>
        {m.kind !== "video" && (
          <>
            <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={() => setZoom((z) => Math.max(1, z - 0.5))} title="Zoom out (−)" aria-label="Zoom out"><MagnifyingGlassMinus size={21} /></button>
            <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={() => setZoom((z) => Math.min(4, z + 0.5))} title="Zoom in (+)" aria-label="Zoom in"><MagnifyingGlassPlus size={21} /></button>
            <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={copy} disabled={!url} title="Copy picture" aria-label="Copy picture" data-testid="viewer-copy"><Copy size={21} /></button>
          </>
        )}
        <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={download} title="Download" aria-label="Download" data-testid="viewer-download"><DownloadSimple size={21} /></button>
        <button type="button" className="rounded-full p-2 hover:bg-white/10" onClick={onClose} title="Close (Esc)" aria-label="Close" data-testid="viewer-close"><X size={22} /></button>
      </div>

      {/* the picture */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onWheel={onWheel}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        {index > 0 && (
          <button type="button" className="absolute left-3 z-10 rounded-full bg-black/40 p-2.5 hover:bg-black/60" onClick={() => go(-1)} aria-label="Previous" data-testid="viewer-prev"><CaretLeft size={24} /></button>
        )}
        {failed ? (
          <div className="flex flex-col items-center gap-2 text-white/70"><ImageBroken size={40} />This file couldn't be loaded</div>
        ) : !url ? (
          <Spinner className="h-8 w-8" />
        ) : m.kind === "video" ? (
          <video key={m.id} src={url} controls autoPlay className="max-h-full max-w-[90%]" data-testid="viewer-video" />
        ) : (
          <img
            src={url}
            alt={m.body || "Photo"}
            draggable={false}
            onMouseDown={onDown}
            onClick={onImageClick}
            className={`max-h-full max-w-[90%] select-none object-contain transition-transform duration-100 ${zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            data-testid="viewer-image"
          />
        )}
        {index < items.length - 1 && (
          <button type="button" className="absolute right-3 z-10 rounded-full bg-black/40 p-2.5 hover:bg-black/60" onClick={() => go(1)} aria-label="Next" data-testid="viewer-next"><CaretRight size={24} /></button>
        )}
      </div>

      {/* what the bot read from this screenshot, and the caption */}
      {(note || (m.body && m.body !== m.media_name)) && (
        <div className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center justify-center gap-2 px-4 text-center text-sm">
          {note && <span className="rounded-md bg-white/10 px-2 py-1 text-[#7CE0B5]" data-testid="viewer-note">{note}</span>}
          {noteId && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-[#00A884] px-2 py-1 text-xs font-semibold"
              onClick={() => navigator.clipboard?.writeText(noteId).then(() => toast.success(`Copied ${noteId}`))}
              data-testid="viewer-copy-id"
            >
              <Copy size={13} /> Copy ID
            </button>
          )}
          {m.body && m.body !== m.media_name && <span className="w-full text-white/80">{m.body}</span>}
        </div>
      )}

      {/* every picture in this chat */}
      {items.length > 1 && (
        <div ref={stripRef} className="shrink-0 overflow-x-auto border-t border-white/10 px-4 py-2">
          <div className="mx-auto flex w-max gap-2">
            {items.map((it, i) => (
              <Thumb key={it.id} m={it} active={i === index} onClick={() => setIndex(i)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
