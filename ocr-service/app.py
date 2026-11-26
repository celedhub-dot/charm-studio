"""Screenshot OCR: image in, text out. Only the Custom Label backend may call it (shared key)."""
import hmac
import io
import os

import pytesseract
from fastapi import FastAPI, Header, HTTPException, Request
from PIL import Image, ImageOps

KEY = os.environ.get("OCR_KEY", "")
MAX_BYTES = 6 * 1024 * 1024
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
async def ocr(request: Request, x_ocr_key: str = Header("")):
    if not KEY or not hmac.compare_digest(x_ocr_key, KEY):
        raise HTTPException(403, "forbidden")
    data = await request.body()
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(413, "image missing or too big")
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("L")
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "not an image")
    if img.width < 1000:  # phone screenshots sent compressed: enlarge so small digits read cleanly
        scale = 1000 / img.width
        img = img.resize((1000, int(img.height * scale)))
    text = pytesseract.image_to_string(img, config="--psm 6")
    return {"text": text[:20000]}
