"""Check label reading and the printed layout with made-up labels shaped like real Meesho / Flipkart / courier ones.
(Real labels contain customer details, so they never go in the repository.) No database needed.

    cd backend
    .venv/Scripts/python.exe tests/test_labels.py
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")
os.environ.setdefault("AI_PROVIDER", "anthropic")

import pymupdf  # noqa: E402
import server  # noqa: E402

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def barcode(page, x, y, w=120, h=30):
    for i in range(int(w // 3)):
        if i % 2 == 0:
            page.draw_rect(pymupdf.Rect(x + i * 3, y, x + i * 3 + 1.2, y + h), color=None, fill=(0, 0, 0))


def meesho_page(doc, oid, with_invoice=True, date="27.10.2026"):
    p = doc.new_page(width=595, height=842)
    p.draw_rect(pymupdf.Rect(10, 10, 585, 335), color=(0, 0, 0), width=1)
    p.insert_text((20, 30), "Customer Address", fontsize=9)
    p.insert_text((20, 45), "Test Customer, 1 Sample Road, Kanpur 208013", fontsize=9)
    barcode(p, 360, 210)
    p.insert_text((360, 200), "1490843210642520", fontsize=12)  # courier AWB: must not be taken as the order ID
    p.insert_text((20, 300), "Product Details", fontsize=9)
    p.insert_text((20, 315), "SKU      Size     Qty     Color     Order No.", fontsize=9)
    p.insert_text((20, 328), f"0911-10  Free Size  1  Lavendar  {oid}", fontsize=9)
    p.draw_line((10, 335), (585, 335), color=(0, 0, 0), width=1)
    if with_invoice:
        p.insert_text((240, 350), "TAX INVOICE", fontsize=10)
        p.insert_text((20, 370), f"Purchase Order No. {oid.split('_')[0]}   Order Date {date}   Invoice Date 28.10.2026", fontsize=8)
        p.insert_text((20, 400), "Description   HSN   Qty   Total", fontsize=8)
        p.insert_text((20, 520), "Tax is not payable on reverse charge basis.", fontsize=8)
    return p


def flipkart_small(doc, oid):
    p = doc.new_page(width=221, height=360)
    p.insert_text((40, 15), oid + " PREPAID", fontsize=7)
    barcode(p, 10, 30, 60, 120)
    p.insert_text((80, 200), "Shipping/Customer address:", fontsize=6)
    p.insert_text((10, 260), "Sold By: CELED HUB, Kanpur", fontsize=5)
    p.insert_text((10, 300), "1 Black-Diary | CELED 2026 A5 Diary", fontsize=5)
    barcode(p, 10, 320, 150, 18)
    p.insert_text((10, 350), "Not for resale.      Printed at 0926 hrs, 30/10/26", fontsize=5)
    return p


def text_rect(page, needle):
    hits = page.search_for(needle)
    return hits[0] if hits else None


print("Reading order IDs")
check(server.detect_ids("Invoice No:\n904018861570\nOrder No:\n904018861570") == ["904018861570"], "12-digit 'Order No:' from other channels")
doc = pymupdf.open()
check(server.detect_ids(meesho_page(doc, "346592266133259264_1").get_text())[0] == "346592266133259264_1", "Meesho sub-order ID first")
check("1490843210642520" not in server.detect_ids(meesho_page(doc, "346592266133259264_1").get_text()), "courier AWB number ignored when an order number is printed")
check(server.detect_ids("OD438950920364369100 PREPAID AWB No. FMPP4422822995") == ["OD438950920364369100"], "Flipkart OD number")
check(server.detect_ids("Order Id:\nOD439013320948438100\nOrder Date: 29-10-2026") == ["OD439013320948438100"], "Flipkart invoice 'Order Id:'")
check(server.detect_ids("please send my order no. soon") == [], "'order no' followed by words isn't an ID")
check(str(server.detect_label_date("Order Date: 29-10-2026, 06:14 PM\nInvoice Date: 29-10-2026")) == "2026-10-29", "Flipkart date with time")
check(server.detect_label_date("Printed at 0926 hrs, 30/10/26") is None, "'Printed at' isn't an order date")

STAMP = ("CUSTOMISATION", ["Name: AARAV", "Charm: Heart", "Notes: gift wrap"], server.GREEN)

print("Meesho A4: box right below the label, invoice moved down")
src = pymupdf.open()
meesho_page(src, "346592266133259264_1")
meesho_page(src, "343610170472105280_1", with_invoice=False)
out = pymupdf.open(stream=server.build_label_pdf(src, [STAMP, STAMP], "bottom-right", 8), filetype="pdf")
check(out.page_count == 2 and out[0].rect.width == 595, "same number of A4 pages")
pg = out[0]
lab, box, inv = text_rect(pg, "Product Details"), text_rect(pg, "CUSTOMISATION"), text_rect(pg, "TAX INVOICE")
check(box and lab and inv and lab.y1 < box.y0 < inv.y0, "order: label, then box, then invoice", (lab, box, inv))
check(box.y0 - 335 >= server.BOX_GAP - 1, "gap between label and box")
order_row = text_rect(pg, "343610170472105280_1") or text_rect(pg, "346592266133259264_1")
check(order_row and order_row.y1 < box.y0, "box doesn't cover the label")
check(text_rect(pg, "Tax is not payable") is not None, "invoice still all there")
check(text_rect(out[1], "CUSTOMISATION").y0 > text_rect(out[1], "Product Details").y1, "label-only page: box below the label")

print("Flipkart 4x6: four per A4 sheet, box under each")
src = pymupdf.open()
for k in range(5):
    flipkart_small(src, f"OD43895092036436910{k}")
stamps = [STAMP] * 5
stamps[1] = ("ORDER NOT FOUND", ["ID: OD438950920364369101", "Check the order in Charm.Studio", ""], server.RED)
out = pymupdf.open(stream=server.build_label_pdf(src, stamps, "bottom-right", 8), filetype="pdf")
check(out.page_count == 2 and out[0].rect.width == 595 and out[0].rect.height == 842, "5 small labels -> 2 A4 sheets")
t = out[0].get_text()
check(t.count("CUSTOMISATION") == 3 and t.count("ORDER NOT FOUND") == 1, "box for each label on the sheet")
first_box = min(out[0].search_for("CUSTOMISATION"), key=lambda r: (r.y0, r.x0))
first_printed = min(out[0].search_for("Printed at"), key=lambda r: (r.y0, r.x0))
check(first_printed.y1 < first_box.y0 and first_box.y0 - first_printed.y1 < 30, "box sits just below its label (with a gap)")
check(out[1].get_text().count("CUSTOMISATION") == 1, "fifth label on the second sheet")

print("Other layouts")
src = pymupdf.open()
p = src.new_page(width=338, height=562)
p.insert_text((20, 60), "Order No: 904018861570", fontsize=10)
barcode(p, 20, 380, 200, 60)
out = pymupdf.open(stream=server.build_label_pdf(src, [STAMP], "bottom-right", 8), filetype="pdf")
b = text_rect(out[0], "CUSTOMISATION")
check(out[0].rect.height == 562 and b and b.y0 > 440, "bigger courier label: box right under its content, page size kept")
src = pymupdf.open()
src.new_page(width=595, height=842).insert_text((50, 80), "Some other document 123456789012_1", fontsize=10)
out = pymupdf.open(stream=server.build_label_pdf(src, [STAMP], "bottom-right", 8), filetype="pdf")
b = text_rect(out[0], "CUSTOMISATION")
check(b and b.x0 > 300 and b.y0 > 600, "unknown A4 layout falls back to the chosen corner")
out = pymupdf.open(stream=server.build_label_pdf(src, [None], "bottom-right", 8), filetype="pdf")
check("CUSTOMISATION" not in out[0].get_text() and out.page_count == 1, "skipped pages stay, without a box")

print("Matching a label to a saved order")
saved = [{"id": "a", "order_id": "346654813867976704"}, {"id": "b", "order_id": "OD439161640237637100"},
         {"id": "c", "order_id": "346653638624478272_1"}, {"id": "d", "order_id": "346653638624478272"}]
m = server.match_orders(["346654813867976704_1"], saved)
check([o["id"] for o in m] == ["a"] and server.label_status(["346654813867976704_1"], m) == "matched",
      "label _1 matches an order saved without _1 (Meesho customers often leave it off)")
m = server.match_orders(["346653638624478272_1"], saved)
check([o["id"] for o in m] == ["c"], "an exact _1 match wins over the plain number")
m = server.match_orders(["346654813867976705_1"], saved)
check(m == [] and server.label_status(["346654813867976705_1"], m) == "not_found", "one wrong digit still matches nobody")
check(server.match_orders(["346654813867976704_2"], saved)[0]["id"] == "a", "_2 label of the same purchase order finds it too")
check(server.match_orders(["OD439161640237637101"], saved) == [], "Flipkart OD: exact only")

print(f"\nALL {passed} CHECKS PASSED")
