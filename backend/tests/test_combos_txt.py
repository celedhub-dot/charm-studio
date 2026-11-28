"""Combos (a name and charm per item), passport cover captions, charm limits with extra charms, the .txt engraving
file (from Label Studio and from a filled PDF) and the Order ID cleaner.

Runs the real app against a throwaway Postgres schema in the database from backend/.env. Made-up data only.

    cd backend
    .venv/Scripts/python.exe tests/test_combos_txt.py
"""
import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
load_dotenv(BACKEND / ".env")

SCHEMA = "charm_test_combo_" + secrets.token_hex(4)
os.environ.update({"DB_SCHEMA": SCHEMA, "AUTH_SECRET": secrets.token_urlsafe(48), "ADMIN_PASSWORD": "legacy-pass-123",
                   "BOT_REPLY_WAIT_SECONDS": "0", "RESET_PASSWORD": "", "WA_NUMBERS": "", "ANTHROPIC_API_KEY": "",
                   "AI_PROVIDER": "anthropic"})


async def sql(query, *args):
    conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
    try:
        if query.startswith("DROP") or query.startswith("CREATE SCHEMA"):
            return await conn.execute(query)
        await conn.execute(f'SET search_path TO "{SCHEMA}"')
        return await conn.execute(query, *args)
    finally:
        await conn.close()


import pymupdf  # noqa: E402
import server  # noqa: E402
import engraving  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

passed = 0


def check(cond, label, extra=""):
    global passed
    if not cond:
        raise AssertionError(f"FAILED: {label} {extra}")
    passed += 1
    print(f"  ok  {label}")


def H(t):
    return {"Authorization": f"Bearer {t}"}


try:
    print("Order ID cleaner")
    C = server.clean_order_id
    check(C("1-#356088034903684") == "356088034903684", "'1-#3560...' -> the ID")
    check(C("-347684119957537408") == "347684119957537408", "'-3476...' -> the ID")
    check(C("Order#342214482554611648") == "342214482554611648", "'Order#...' -> the ID")
    check(C("od 4392 6079 3774 9281 00") == "OD439260793774928100", "Flipkart OD with spaces, upper-cased")
    check(C("357444445555666677_1") == "357444445555666677_1", "Meesho _1 kept")
    check(C("wa-1a2b3c4d") == "wa-1a2b3c4d", "placeholder IDs untouched")

    print("Names keep the customer's emojis")
    said = "Outside name Prashanth ❤️‍\U0001FA79\nInside name chinnu\U0001F618"
    check(server.keep_emojis("Outside: Prashanth | Inside: chinnu", said) == "Outside: Prashanth ❤️‍\U0001FA79 | Inside: chinnu\U0001F618",
          "emojis the AI dropped are put back on each name")
    check(server.keep_emojis("Aarav", "name Aarav") == "Aarav" and server.keep_emojis("VINAY ♥ VARSHA", "VINAY ♥ VARSHA") == "VINAY ♥ VARSHA",
          "names without emojis, or already with them, stay the same")

    print("Catalogue match for a cut-off screenshot title")
    import catalogue as cat
    listings = [{"title": "Latest Gift Pack of Customised wallet & Glitered Pen for Men Green", "sku": "A"},
                {"title": "Newly Customised Combo Pack of Wallet, Metal Keychain & Glitered Pen Tan", "sku": "B"},
                {"title": "Customised Glitered Pen with Name| Metal Pen with Name Engraved| Best gift pen", "sku": "C"}]
    check(cat.best_match("Customised Glitered Pen with Na...", listings)["sku"] == "C", "a pen screenshot matches the pen, not a wallet + pen pack")
    check(cat.best_match("Latest Gift Pack of Customised wallet & Glite...", listings)["sku"] == "A", "a wallet + pen pack still matches the pack")
    check(cat.best_match("Newly Customised Combo Pack of Wallet, Metal K...", listings)["sku"] == "B", "a 3-item combo still matches the combo")

    print("Combos: one name for all, or a name per item")
    items = "wallet,passport cover,metal keychain"
    check(server.combo_names({"_items": items, "product_name": "Aarav"}) ==
          {"wallet": "Aarav", "passport cover": "Aarav", "metal keychain": "Aarav"}, "one name goes on every item")
    names = server.combo_names({"_items": items, "product_name": "Wallet: Aarav | Passport cover: Riya | Keychain: Dev"})
    check(names == {"wallet": "Aarav", "passport cover": "Riya", "metal keychain": "Dev"}, "a different name per item", names)
    check(server.step_filled({"_items": items, "product_name": "Aarav"}, "product_name"), "one name completes a combo")
    charms_ = server.combo_charms({"_items": items, "charm": "52 (Om)"})
    check(charms_ == {"wallet": "52 (Om)", "passport cover": "52 (Om)"}, "one charm for every charm item (not the metal keychain)", charms_)
    text, opts = server.resolve_charm_text("Wallet: om | Passport cover: 46, 9")
    check(text == "Wallet: 52 (Om) | Passport cover: 46 (Red heart), 9 (Doctor symbol)" and not opts, "charms per item resolved to the chart", text)
    check(server.resolve_charm_text("46, 2721") is None, "a number off the chart is refused")
    check(server.resolve_charm_text("46, crown")[1] == [2, 3, 4], "a name fitting several charms asks for the number")

    print("Charm limits (Rs 20 per extra charm)")
    L = server.limit_charms
    check(L("46, 9, 5", "passport cover", False) == ("46, 9", "5"), "passport cover: 2 free")
    check(L("46, 9, 5", "passport cover", True) == ("46, 9, 5", ""), "passport cover with a caption: 3 free")
    check(L("46, 9, 5, 3", "passport cover", True) == ("46, 9, 5", "3"), "caption passport cover: 4th charm is extra")
    check(L("46, 9", "wallet", False) == ("46", "9"), "wallet: 1 free")
    check(L("46, 9", "", False) == ("46, 9", ""), "product unknown: nothing held back")

    print("Label box")
    st = server.order_stamp({"product_name": "Riya", "caption": "Happy journey\nTravel safe", "charm": "46 (Red heart)"})
    check(st[1][:3] == ["Name: Riya", "  Happy journey", "  Travel safe"], "caption lines printed separately under the name", st[1])
    cs = server.combo_stamp([{"product_name": "Aarav", "charm": "52 (Om)", "notes": "Item: Wallet"},
                             {"product_name": "Riya", "charm": "46 (Red heart)", "notes": "Item: Passport cover", "caption": "Happy journey"},
                             {"product_name": "Dev", "charm": "", "notes": "Item: Keychain; gift wrap"}])
    check(cs[1][0].startswith("Wallet: Aarav") and "52 (Om)" in cs[1][0] and cs[1][1].startswith("Passport cover: Riya")
          and cs[1][2] == "  Happy journey" and cs[1][3] == "Keychain: Dev" and cs[1][-1] == "Notes: gift wrap",
          "combo: one line per item with its own name and charm, caption under the passport cover", cs[1])

    print(".txt engraving file")
    blocks = engraving.txt_blocks_for_page(
        [{"product_name": "Aarav", "notes": "Item: Wallet"}, {"product_name": "Riya", "notes": "Item: Passport cover", "caption": "Happy journey"},
         {"product_name": "Dev", "notes": "Item: Keychain"}, {"product_name": "Ira", "notes": "Item: Bottle"}],
        "Wallet passport cover keychain bottle combo", 1, "")
    blocks += engraving.txt_blocks_for_page([{"product_name": "Dr. Test", "quantity": "2"}], "Special Customised Doctor keychain with name", 1, "")
    blocks += engraving.txt_blocks_for_page([{"product_name": "Adv. Demo"}], "Trendy Customised name keychain for advocate | Metal Keychain", 1, "")
    blocks += engraving.txt_blocks_for_page([{"product_name": "Vinay"}], "Customised Stylist Kada/Braclet for Men Silver", 1, "")
    blocks += engraving.txt_blocks_for_page([{"product_name": "Neha"}], "Customised Name Bracelet for Women", 1, "")
    blocks += engraving.txt_blocks_for_page([], "", 1, "357000000000000001")
    txt = engraving.build_txt(blocks).replace("\r\n", "\n")
    check(txt.startswith("LEATHER (STRAP) (2)\nAarav\nRiya\nHappy journey\n"), "leather names first, caption under its name", txt[:80])
    check("METAL KEYCHAIN (1)\nDev" in txt and "BOTTLE (1)\nIra" in txt, "metal items under their own headings")
    check("DOCTOR KEYCHAIN (2)\nDr. Test\nDr. Test" in txt and "ADVOCATE KEYCHAIN (1)\nAdv. Demo" in txt, "doctor/advocate keychains, repeated for quantity")
    check("KADA (1)\nVinay" in txt and "BRACELET (1)\nNeha" in txt and txt.index("BRACELET") < txt.index("KADA"),
          "kada listed in its own section, apart from bracelets")
    check(txt.index("LEATHER") < txt.index("METAL KEYCHAIN") < txt.index("DOCTOR") < txt.index("BOTTLE") < txt.index("NAME MISSING"),
          "headings in the agreed order")

    asyncio.run(sql(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"'))
    with TestClient(server.app) as c:
        tok = c.post("/api/auth/login", json={"password": "legacy-pass-123"}).json()["token"]
        tok = c.post("/api/account/setup", headers=H(tok), json={"name": "Owner", "email": "o@x.test", "password": "mango-river-42"}).json()["token"]

        print("Saved order IDs are cleaned")
        asyncio.run(sql("INSERT INTO orders (id, order_id, product_name, created_at) VALUES ('x1', '-347600000000000408', 'A', now()), "
                        "('x2', '1-#356000000003684', 'B', now()), ('x3', 'wa-abc12345', 'C', now())"))
        check(c.portal.call(server.clean_saved_order_ids) == 2, "existing messy IDs cleaned (placeholders left)")
        ids = {o["id"]: o["order_id"] for o in c.get("/api/orders", headers=H(tok)).json()}
        check(ids["x1"] == "347600000000000408" and ids["x2"] == "356000000003684" and ids["x3"] == "wa-abc12345", "cleaned in the database", ids)
        o = c.post("/api/orders", headers=H(tok), json={"order_id": "Order# 3579 0000 1111 2222", "product_name": "Riya",
                                                        "caption": "Happy journey\nTravel safe\nLine 3\nLine 4\nLine 5"}).json()
        check(o["order_id"] == "3579000011112222" and o["caption"] == "Happy journey\nTravel safe\nLine 3\nLine 4", "new order: ID cleaned, caption kept to 4 lines", o)
        u = c.patch(f"/api/orders/{o['id']}", headers=H(tok), json={"order_id": "#-3579000011112222"}).json()
        check(u["order_id"] == "3579000011112222", "edited order ID cleaned too", u)

        print("Extra charms wait for staff to confirm the payment")
        e = c.post("/api/orders", headers=H(tok), json={"order_id": "357900002222333344", "product_name": "Meera", "charm": "46 (Red heart), 9 (Doctor symbol)",
                                                        "extra_charms": "5 (Infinity love)"}).json()
        r = c.post(f"/api/orders/{e['id']}/extra-charms", headers=H(tok), json={"confirm": True}).json()
        check(r["charm"] == "46 (Red heart), 9 (Doctor symbol), 5 (Infinity love)" and r["extra_charms"] == "", "payment confirmed: the extra charm joins the label", r)
        check(c.post(f"/api/orders/{e['id']}/extra-charms", headers=H(tok), json={"confirm": True}).status_code == 400, "nothing left to confirm")

        print(".txt from Label Studio and from a filled PDF")
        c.post("/api/orders", headers=H(tok), json={"order_id": "357911112222333344", "product_name": "Kabir"})
        src = pymupdf.open()
        src.new_page(width=595, height=842).insert_text((50, 80), "Order ID: 357911112222333344\nWallet for men", fontsize=10)
        pdf = src.tobytes()
        t = c.post("/api/pdf/annotate", headers=H(tok), files={"file": ("labels.pdf", pdf, "application/pdf")}, data={"output": "txt"})
        check(t.status_code == 200 and "Kabir" in t.content.decode("utf-8-sig") and t.headers["content-disposition"].endswith('.txt"'),
              "Label Studio gives the .txt", t.text[:200])
        filled = c.post("/api/pdf/annotate", headers=H(tok), files={"file": ("labels.pdf", pdf, "application/pdf")})
        check(filled.status_code == 200, "filled PDF made")
        t2 = c.post("/api/pdf/engraving-txt", headers=H(tok), files={"file": ("annotated_labels.pdf", filled.content, "application/pdf")})
        check(t2.status_code == 200 and "Kabir" in t2.content.decode("utf-8-sig"), "uploading the filled PDF gives the same .txt", t2.text[:200])
        bare = pymupdf.open(stream=filled.content, filetype="pdf")
        bare.embfile_del(server.ENGRAVING_EMBED)
        t3 = c.post("/api/pdf/engraving-txt", headers=H(tok), files={"file": ("old.pdf", bare.tobytes(), "application/pdf")})
        check(t3.status_code == 200 and "Kabir" in t3.content.decode("utf-8-sig"), "an older filled PDF: names looked up from its order IDs", t3.text[:200])
        none = pymupdf.open()
        none.new_page().insert_text((50, 80), "hello", fontsize=10)
        check(c.post("/api/pdf/engraving-txt", headers=H(tok), files={"file": ("x.pdf", none.tobytes(), "application/pdf")}).status_code == 400,
              "a PDF without order IDs is refused")

    print(f"\nALL {passed} CHECKS PASSED")
finally:
    asyncio.run(sql(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
    print(f"(dropped test schema {SCHEMA})")
