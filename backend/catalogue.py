"""Products and what each one needs from the customer (name, charm, logo).

Only product names, IDs, SKU and type are kept from the marketplace export files: prices, stock, tax and
shipping are never read into the app. The AI is told only which details to ask for.
"""
from __future__ import annotations

import io
import re
from typing import Dict, Iterable, List, Optional, Tuple

ITEM_ORDER = ["wallet", "purse", "clutch", "passport cover", "leather keychain", "metal keychain", "keychain",
              "pen", "bracelet", "rakhi", "chain", "card holder", "belt"]

# what each item type needs (wallet/purse/clutch/passport/leather keychain take a charm number;
# a metal keychain takes a name and/or a logo image; pens, bracelets, rakhis and chains only a name;
# belts and card holders aren't personalised)
NEEDS: Dict[str, Tuple[bool, bool]] = {  # item -> (name, charm)
    "wallet": (True, True), "purse": (True, True), "clutch": (True, True), "passport cover": (True, True),
    "leather keychain": (True, True), "metal keychain": (True, False), "keychain": (True, False),
    "pen": (True, False), "bracelet": (True, False), "rakhi": (True, False), "chain": (True, False),
    "card holder": (False, False), "belt": (False, False),
}
LOGO_OK = {"metal keychain", "keychain", "leather keychain"}
COLOUR_CHANGE_OK = {"wallet", "purse", "clutch", "passport cover"}

_RX = [
    ("passport cover", r"passport"),
    ("clutch", r"clutch"),
    ("purse", r"(?:ladies|women'?s?|womens)\b[^|]{0,30}\b(?:purse|wallet)|(?:purse|wallet) for (?:ladies|women)"),
    ("wallet", r"wallet"),
    ("leather keychain", r"leather\s+key\s*-?\s*(?:chain|ring)"),
    ("metal keychain", r"(?:metal|steel|metallic|engraved|laser)\b[^|]{0,40}key\s*-?\s*(?:chain|ring)|key\s*-?\s*(?:chain|ring)[^|]{0,40}\b(?:metal|steel|metallic)"),
    ("keychain", r"key\s*-?\s*(?:chain|ring)|keytchain|keyring"),
    ("pen", r"\bpens?\b"),
    ("bracelet", r"bracelet|braclet|\bkada\b"),
    ("rakhi", r"rakhi"),
    ("chain", r"neck\s*chain|\bchain\b(?!\s*&)|pendant|locket|necklace"),
    ("card holder", r"card\s*holder"),
    ("belt", r"\bbelt\b"),
]


def items_in(title: str) -> List[str]:
    """Item types a product title names, e.g. 'Wallet, Keychain & Pen Combo' -> [wallet, metal keychain, pen]."""
    t = (title or "").lower()
    found: List[str] = []
    for item, rx in _RX:
        m = re.search(rx, t)
        if not m:
            continue
        if item in ("keychain", "metal keychain") and any(k in found for k in ("leather keychain", "metal keychain")):
            continue
        if item in ("chain", "card holder") and any(k in found for k in ("clutch", "purse")):
            continue  # a clutch's chain strap / card slots, not a separate item
        if item == "purse" and "clutch" in found:
            continue  # "ladies clutch purse" is one item
        if item == "wallet" and ("purse" in found or "clutch" in found) and not re.search(
                r"wallet\s*(?:&|and|,|\+)\s*(?:ladies\s*|women'?s?\s*|\d-fold\s*)*(?:clutch|purse)"
                r"|(?:clutch|purse)\s*(?:&|and|,|\+)\s*(?:men'?s?\s*)?wallet|\bcombo\b", t):
            continue  # a women's clutch/purse wallet is one item; "wallet & ladies clutch combo" is two
        if item == "chain" and re.search(r"key\s*-?\s*chain", t[max(0, m.start() - 6): m.end() + 1]):
            continue  # the "chain" in "key chain"
        if item == "card holder" and "wallet" in found:
            continue  # "wallet & card holder" is a wallet feature, not a separate item
        found.append(item)
    if "keychain" in found and ("wallet" in found or "purse" in found):
        found[found.index("keychain")] = "metal keychain"  # combo keychains are metal unless the title says leather
    return found


def needs_for(title: str) -> Dict[str, object]:
    """What the bot must collect for this product. Unknown products keep the old behaviour (name + charm)."""
    items = items_in(title)
    if not items:
        return {"items": [], "name": True, "charm": True, "logo": False, "colour_change": True, "known": False}
    personal = [i for i in items if NEEDS[i][0]]
    return {
        "items": personal if len(personal) > 1 else [],
        "name": bool(personal),
        "charm": any(NEEDS[i][1] for i in items),
        "logo": any(i in LOGO_OK for i in items),
        "colour_change": any(i in COLOUR_CHANGE_OK for i in items),
        "known": True,
    }


# ---------------------------------------------------------------------------
# Marketplace export files -> catalogue rows (names/IDs only)
# ---------------------------------------------------------------------------
def _norm(s: object) -> str:
    return " ".join(str(s or "").split())


def _rows_xlsx(data: bytes) -> List[List[str]]:
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    return [[_norm(c) for c in row] for row in ws.iter_rows(values_only=True)]


def _rows_xls(data: bytes) -> List[List[str]]:
    import xlrd
    sh = xlrd.open_workbook(file_contents=data).sheet_by_index(0)
    return [[_norm(v) for v in sh.row_values(r)] for r in range(sh.nrows)]


def _rows_csv(data: bytes) -> List[List[str]]:
    import csv
    text = data.decode("utf-8-sig", errors="ignore")
    return [[_norm(c) for c in row] for row in csv.reader(io.StringIO(text))]


def parse_export(filename: str, data: bytes) -> Tuple[str, List[Dict[str, str]]]:
    """Read a Meesho inventory file or a Flipkart listing file. Returns (marketplace, rows)."""
    name = (filename or "").lower()
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" or name.endswith(".xls"):
        rows = _rows_xls(data)
    elif data[:2] == b"PK" or name.endswith(".xlsx"):
        rows = _rows_xlsx(data)
    else:
        rows = _rows_csv(data)
    for h, header in enumerate(rows[:10]):
        cols = {c.strip().upper(): i for i, c in enumerate(header) if c}
        if "PRODUCT NAME" in cols and "PRODUCT ID" in cols:  # Meesho inventory update file
            out = []
            for r in rows[h + 1:]:
                get = lambda k: r[cols[k]] if k in cols and cols[k] < len(r) else ""  # noqa: E731
                pid, title = get("PRODUCT ID"), get("PRODUCT NAME")
                if not pid or not re.fullmatch(r"\d{5,}", pid.split(".")[0]) or not title:
                    continue  # the description row under the header, blanks
                out.append({"product_id": pid.split(".")[0], "sku": get("STYLE ID"), "title": title[:300],
                            "group": get("CATALOG NAME")[:200], "active": True})
            return "meesho", out
        if "PRODUCT TITLE" in cols and "SELLER SKU ID" in cols:  # Flipkart listing file
            out = []
            for r in rows[h + 1:]:
                get = lambda k: r[cols[k]] if k in cols and cols[k] < len(r) else ""  # noqa: E731
                title, sku = get("PRODUCT TITLE"), get("SELLER SKU ID")
                status = get("LISTING STATUS").upper()
                if not title or title.lower().startswith("title of your product"):
                    continue
                out.append({"product_id": get("LISTING ID") or get("FLIPKART SERIAL NUMBER") or sku, "sku": sku,
                            "title": title[:300], "group": get("SUB-CATEGORY")[:200],
                            "active": status in ("", "ACTIVE")})
            return "flipkart", out
    raise ValueError("This doesn't look like a Meesho inventory file or a Flipkart listing file.")


_STOP = {"for", "with", "and", "the", "of", "men", "women", "&", "|", "-", "customised", "customized", "personalised",
         "personalized", "custom", "name", "new", "latest", "trendy", "stylish", "premium", "gift"}


def _tokens(s: str) -> set:
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in _STOP and len(w) > 1}


def best_match(title: str, products: Iterable[Dict[str, str]]) -> Optional[Dict[str, str]]:
    """The catalogue product a (possibly cut-off) screenshot title refers to, if one fits well."""
    want = _tokens(title)
    if len(want) < 2:
        return None
    best, score = None, 0.0
    for p in products:
        have = _tokens(p["title"])
        if not have:
            continue
        s = len(want & have) / len(want)
        if s > score:
            best, score = p, s
    return best if score >= 0.6 else None
