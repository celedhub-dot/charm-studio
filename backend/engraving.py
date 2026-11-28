"""The engraving list page added in front of a label PDF: every name to engrave, by category.

Categories (as the team sorts them in WhatsApp):
  1. Golden strip   - wallet, purse, clutch, passport cover, leather keychain
  2. Metal pen
  3. Metal keychain - two sides written as "Side 1     Side 2"
  then Bracelet, Neck chain, Rakhi (own sections) and "Name missing".
A name is listed once per piece (quantity), with its label number.
"""
from __future__ import annotations

import html
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

import catalogue as cat

SECTIONS = [
    ("golden", "1. GOLDEN STRIP", "wallet, purse, clutch, passport cover, leather keychain"),
    ("pen", "2. METAL PEN", ""),
    ("metal", "3. METAL KEYCHAIN", "two sides: Side 1     Side 2"),
    ("bracelet", "BRACELET", ""),
    ("chain", "NECK CHAIN", ""),
    ("rakhi", "RAKHI", ""),
    ("unknown", "PRODUCT NOT CLEAR", "check the label to see which item it is"),
    ("missing", "NAME MISSING", "no order or no name saved for these labels"),
]
ITEM_SECTION = {
    "wallet": "golden", "purse": "golden", "clutch": "golden", "passport cover": "golden", "leather keychain": "golden",
    "pen": "pen", "metal keychain": "metal", "keychain": "metal",
    "bracelet": "bracelet", "chain": "chain", "rakhi": "rakhi",
}  # belts and card holders aren't engraved
_SIDE_RE = re.compile(r"(?:other|back|second|another|2nd|dusri|doosri|peeche|piche|reverse)\s*side[^:\-]*[:\-]\s*(.+)", re.I)


def label_product(text: str, catalogue: Iterable[Dict[str, str]]) -> Tuple[str, int]:
    """(product title, quantity) printed on a Meesho / Flipkart label page ('' / 1 when unclear)."""
    lines = [ln.strip() for ln in (text or "").splitlines()]
    title, qty = "", 1
    # Meesho: "Product Details" then SKU / Size / Qty / Color / Order No. headers, then their values
    try:
        at = lines.index("Product Details")
        heads = lines[at + 1: at + 6]
        if [h.lower() for h in heads[:3]] == ["sku", "size", "qty"]:
            vals = lines[at + 6: at + 11]
            sku = vals[0] if vals else ""
            if len(vals) > 2 and vals[2].isdigit():
                qty = max(1, min(int(vals[2]), 50))
            hit = next((p for p in catalogue if p.get("sku") and p["sku"].strip().lower() == sku.lower()), None)
            if hit:
                title = hit["title"]
    except ValueError:
        pass
    # Meesho invoice: the product description sits under the Description...Total headers, until the HSN code
    if not title and "Description" in lines:
        start = lines.index("Description")
        try:
            end_hdr = lines.index("Total", start)
            desc = []
            for ln in lines[end_hdr + 1: end_hdr + 8]:
                if re.fullmatch(r"\d{4,8}", ln):
                    break
                desc.append(ln)
            title = " ".join(desc).strip()
        except ValueError:
            pass
    # Flipkart: "1 SKU | Product title"
    if not title:
        for ln in lines:
            m = re.match(r"^(\d{1,2})\s+(.+?\|\s*.+)$", ln)
            if m:
                qty = max(1, min(int(m.group(1)), 50))
                title = m.group(2)
                break
    return title[:200], qty


def sides(order: Dict[str, Any]) -> str:
    """'Name     Other side' for a two-sided metal keychain, else just the name."""
    name = (order.get("product_name") or "").strip()
    m = _SIDE_RE.search(order.get("notes") or "")
    back = m.group(1).strip().strip("'\"") if m else ""
    back = re.split(r"\s*;\s*", back)[0][:60]
    return f"{name}     {back}" if back and name else name


def item_of(order: Dict[str, Any]) -> str:
    m = re.search(r"Item:\s*([^;]+)", order.get("notes") or "")
    if not m:
        return ""
    found = cat.items_in(m.group(1))
    return found[0] if found else ""


def entries_for_page(page_no: int, orders: List[Dict[str, Any]], title: str, qty: int, detected: str) -> List[Tuple[str, str]]:
    """(section, line) pairs for one label page. orders: the matched order (or a combo's rows)."""
    if not orders:
        return [("missing", f"{detected or 'no order ID'}   p.{page_no}")]
    out: List[Tuple[str, str]] = []
    items_from_title = cat.items_in(title) if title else []
    for o in orders:
        name = (o.get("product_name") or "").strip()
        if not name:
            out.append(("missing", f"{o.get('order_id') or detected}   p.{page_no}"))
            continue
        try:
            n = max(1, min(int(str(o.get("quantity") or "").strip() or qty), 50))
        except ValueError:
            n = qty
        own = item_of(o)
        items = [own] if own else (items_from_title or [])
        targets = [ITEM_SECTION[i] for i in items if i in ITEM_SECTION] if items else ["unknown"]
        if items and not targets:
            continue  # belt / card holder: nothing to engrave
        for sec in dict.fromkeys(targets):
            line = sides(o) if sec == "metal" else name
            out += [(sec, f"{line}   p.{page_no}")] * n
    return out


def list_html(entries: List[Tuple[str, str]], pdf_name: str) -> str:
    by: Dict[str, List[str]] = {}
    for sec, line in entries:
        by.setdefault(sec, []).append(line)
    parts = [f"<h1>Engraving list</h1><p class='sub'>{html.escape(pdf_name)} &middot; {sum(len(v) for k, v in by.items() if k != 'missing')} pieces</p>"]
    for key, head, hint in SECTIONS:
        names = by.get(key)
        if not names:
            continue
        parts.append(f"<h2>{head} <span class='n'>({len(names)})</span></h2>")
        if hint:
            parts.append(f"<p class='hint'>{html.escape(hint)}</p>")
        parts.append("<ol>" + "".join(f"<li>{html.escape(x).replace('&amp;nbsp;', '&nbsp;')}</li>" for x in names) + "</ol>")
    return "".join(parts)


CSS = """
* { font-family: sans-serif; }
h1 { font-size: 16pt; margin: 0 0 2pt 0; }
.sub { font-size: 9pt; color: #666; margin: 0 0 8pt 0; }
h2 { font-size: 11.5pt; margin: 10pt 0 2pt 0; border-bottom: 1px solid #999; }
.n { font-weight: normal; color: #555; }
.hint { font-size: 8.5pt; color: #666; margin: 0 0 3pt 0; }
ol { margin: 0; padding-left: 18pt; }
li { font-size: 10.5pt; margin: 0 0 1.5pt 0; }
"""


def build_list_pdf(entries: List[Tuple[str, str]], pdf_name: str, width: float = 595, height: float = 842) -> Optional[bytes]:
    """A4 page(s) with the engraving list; None when there's nothing to list."""
    if not entries:
        return None
    import io
    import pymupdf as fitz
    story = fitz.Story(html=list_html(entries, pdf_name), user_css=CSS)
    buf = io.BytesIO()
    writer = fitz.DocumentWriter(buf)
    page_rect = fitz.Rect(0, 0, width, height)
    box = page_rect + (36, 36, -36, -36)
    more = True
    while more:
        dev = writer.begin_page(page_rect)
        more, _ = story.place(box)
        story.draw(dev)
        writer.end_page()
    writer.close()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# The .txt file for the laser engraver: names only, by how each item is engraved
# ---------------------------------------------------------------------------
TXT_SECTIONS = [
    ("leather", "LEATHER (STRAP)"),
    ("metal", "METAL KEYCHAIN"),
    ("doctor", "DOCTOR KEYCHAIN"),
    ("advocate", "ADVOCATE KEYCHAIN"),
    ("ca", "CA KEYCHAIN"),
    ("home", "HOME KEYCHAIN"),
    ("pen", "PEN"),
    ("bottle", "BOTTLE"),
    ("bracelet", "BRACELET"),
    ("kada", "KADA"),
    ("chain", "NECK CHAIN"),
    ("rakhi", "RAKHI"),
    ("unknown", "OTHER / NOT CLEAR"),
    ("missing", "NAME MISSING"),
]
LEATHER_ITEMS = {"wallet", "purse", "clutch", "passport cover", "leather keychain", "luggage tag", "sunglasses cover"}
TXT_ITEM = {"pen": "pen", "bottle": "bottle", "bracelet": "bracelet", "chain": "chain", "rakhi": "rakhi"}


def metal_kind(title: str) -> str:
    """Which metal keychain heading a product title belongs under."""
    t = (title or "").lower()
    if re.search(r"\bdoctor\b|\bdr\b|\bmbbs\b|\bmedical\b", t):
        return "doctor"
    if re.search(r"advocate|\badv\b|lawyer|vakeel", t):
        return "advocate"
    if re.search(r"\bca\b|chartered", t):
        return "ca"
    if re.search(r"\bhome\b|\bhouse\b|ghar", t):
        return "home"
    return "metal"


def txt_section(item: str, title: str) -> str:
    if item in LEATHER_ITEMS:
        return "leather"
    if item in ("metal keychain", "keychain"):
        return metal_kind(title)
    if item == "bracelet" and re.search(r"\bkad(?:a|aa|e)\b|\bkara\b|\bkangan\b|\bkangna\b", (title or "").lower()):
        return "kada"  # a kada is engraved separately from bracelets
    return TXT_ITEM.get(item, "")


def txt_blocks_for_page(orders: List[Dict[str, Any]], title: str, qty: int, detected: str) -> List[Tuple[str, List[str]]]:
    """(section, lines) blocks for one label: each item's name, repeated for the quantity; a passport cover's
    caption lines follow its name. A single name for a combo is listed under every item."""
    if not orders:
        return [("missing", [detected or "no order ID"])]
    out: List[Tuple[str, List[str]]] = []
    items_from_title = cat.items_in(title) if title else []
    for o in orders:
        name = (o.get("product_name") or "").strip()
        if not name:
            out.append(("missing", [o.get("order_id") or detected or "no order ID"]))
            continue
        try:
            n = max(1, min(int(str(o.get("quantity") or "").strip() or qty), 50))
        except ValueError:
            n = qty
        own = item_of(o)
        items = [own] if own else (items_from_title or [])
        sections = [txt_section(i, title) for i in items] if items else ["unknown"]
        sections = [s for s in dict.fromkeys(sections) if s] or ([] if items else ["unknown"])
        if items and not sections:
            continue  # belt / card holder: nothing to engrave
        caption = [ln.strip() for ln in (o.get("caption") or "").splitlines() if ln.strip()]
        for sec in sections:
            line = name if sec in ("leather", "pen", "bottle", "bracelet", "kada", "chain", "rakhi", "unknown") else sides(o)
            lines = [line] + (caption if sec == "leather" and caption else [])
            for _ in range(n):
                out.append((sec, lines + ([""] if len(lines) > 1 else [])))
    return out


def build_txt(blocks: List[Tuple[str, List[str]]], pdf_name: str = "") -> str:
    """Plain text for the laser software: headings, then the names one per line (CRLF for Windows tools)."""
    by_sec: Dict[str, List[List[str]]] = {}
    for sec, lines in blocks:
        by_sec.setdefault(sec, []).append(lines)
    parts: List[str] = []
    for key, heading in TXT_SECTIONS:
        if key not in by_sec:
            continue
        count = len(by_sec[key])
        parts.append(f"{heading} ({count})")
        for lines in by_sec[key]:
            parts.extend(lines)
        if parts[-1] != "":
            parts.append("")
    return "\r\n".join(parts).rstrip() + "\r\n" if parts else ""
