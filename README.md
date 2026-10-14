# Image API

Two endpoints:

- `POST /api/move` — **binary symbol classifier**. Returns `0` or `1` for a hand-drawn `O` / `X` on a blank canvas. No OCR, ~10-30 ms, pure geometry. This is what a Unity game should use.
- `POST /api/ocr` — general text extraction, powered by [tesseract.js](https://github.com/naptha/tesseract.js) v7 (Tesseract 5 compiled to WebAssembly).

**No system install required.** There is no `brew install tesseract` / `choco install tesseract` step: the WASM engine ships inside `node_modules/tesseract.js-core`, and the language data downloads once into `.tesseract-cache/`. `/api/move` does not even use tesseract — only `pngjs`.

## Setup

```bash
npm install
npm run precache          # optional: pre-download eng.traineddata so the first OCR request is fast
npm start                 # or: npm run watch
```

## POST /api/move — the game endpoint

Send the canvas as **PNG bytes** (`Content-Type: image/png` or `application/octet-stream`), or as JSON `{ "file": "data:image/png;base64,..." }`.

```json
{
  "status": "ok",
  "response": {
    "result": 1,
    "label": "X",
    "confidence": 88,
    "needsRetry": false,
    "features": { "center": 1, "corners": 0.15, "edges": 0, "holes": 0 }
  }
}
```

- `result` — `0` for `O`, `1` for `X`. That is the whole API contract.
- `confidence` — 50..100. 50 is a coin flip.
- `needsRetry` — `true` when confidence is under `SYMBOL_MIN_CONFIDENCE` (65). Ask the child to draw again instead of guessing.
- `features` — the raw signals, useful if you ever want to retune the thresholds.

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 400  | no image in the request                                |
| 415  | not a PNG (send `Texture2D.EncodeToPNG()`)             |
| 422  | blank canvas, nothing drawn                           |

### Unity

```csharp
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

[System.Serializable] class MoveResponse { public string status; public MoveData response; }
[System.Serializable] class MoveData { public int result; public string label; public int confidence; public bool needsRetry; }

IEnumerator SendMove(Texture2D canvas)
{
    byte[] png = canvas.EncodeToPNG();

    using (var req = new UnityWebRequest("http://localhost:5000/api/move", "POST"))
    {
        req.uploadHandler = new UploadHandlerRaw(png);       // raw bytes, not base64
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("Content-Type", "image/png");
        yield return req.SendWebRequest();

        if (req.result != UnityWebRequest.Result.Success) { ShowError(); yield break; }

        var json = JsonUtility.FromJson<MoveResponse>(req.downloadHandler.text);
        if (json.response.needsRetry) { AskChildToDrawAgain(); }
        else { ApplyMove(json.response.result); }           // 0 = O, 1 = X
    }
}
```

Tips: export the canvas **transparent** if you can (ink is then read straight from the alpha channel, which is the most reliable path). An opaque canvas works too — the ink is found automatically with Otsu thresholding, on light or dark backgrounds. CORS is already open for Unity WebGL.

### How it decides

No machine learning, just four signals measured on a 32x32 grid resampled from the ink bounding box:

| Signal | `X` | `O` |
| ------ | --- | --- |
| `center` — ink in the middle 12% | high (strokes cross) | 0 (hollow) |
| `corners` — ink in the four corners | high (stroke tips) | 0 (curve misses them) |
| `edges` — ink at the four edge midpoints | 0 | high (the arc passes through) |
| `holes` — enclosed background after flood fill | 0 | one big hole |

Weighted into an `X` score and an `O` score; the winner plus the margin becomes `result` and `confidence`. Position, size, stroke thickness, wobble and a gap in the loop are all normalised away. Swap the mapping if you want `X` to be `0`.

## POST /api/ocr — text extraction

`POST http://localhost:5000/api/ocr` with `Content-Type: application/json`:

```json
{
  "file": "data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAA..kJggg==",
  "lang": "eng"
}
```

- `file` — required. A `data:image/...;base64,` URL, a bare base64 string, or (server-side) a `Buffer`.
- `lang` — optional, defaults to `eng`. Also accepted as `?lang=eng`. Others: `fra`, `deu`, `spa`, `hin`, `jpn`, `ara`, ...

Convert an image to base64 at https://www.base64-image.de/.

## Response

```json
{
  "status": "ok",
  "response": { "text": "LOBSTER BISQUE ...", "confidence": 87, "language": "eng" }
}
```

`confidence` is 0-100 (Tesseract's mean word confidence). A low value means a blurry, skewed or low-contrast image.

Errors come back as JSON with a matching status code:

```json
{ "status": "error", "message": "`file` is not valid base64 image data." }
```

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 400  | `file` missing, not a string, not valid base64, bad `lang` |
| 413  | image larger than `OCR_MAX_BYTES`                           |
| 503  | OCR engine failed to start                                  |
| 504  | recognition exceeded `OCR_TIMEOUT_MS`                       |
| 500  | OCR engine failed mid-recognition                           |

## Config

| Variable         | Default                | Purpose                                                |
| ---------------- | ---------------------- | ------------------------------------------------------ |
| `PORT`           | `5000`                 | listen port                                            |
| `OCR_LANG`       | `eng`                  | default language                                       |
| `OCR_TIMEOUT_MS` | `30000`                | per-request recognition timeout                        |
| `OCR_MAX_BYTES`  | `5242880` (5 MB)       | max decoded image size                                 |
| `OCR_CACHE_DIR`  | `./.tesseract-cache`   | where `*.traineddata` is cached                        |
| `BODY_LIMIT`     | `7mb`                  | JSON body limit; keep it above `OCR_MAX_BYTES` in base64 |
| `IMAGE_LIMIT`    | `6mb`                  | max PNG body for `/api/move`                             |
| `SYMBOL_MIN_CONFIDENCE` | `65`            | below this, `/api/move` sets `needsRetry: true`          |

## Tests

```bash
npm test
```

34 `node:test` cases: 11 for the OCR endpoint, 23 for the symbol classifier (clean/thin/thick/tiny/huge/wobbly/off-centre/gapped strokes, light-on-dark and dark-on-light canvases, blank canvas, non-PNG bytes, and the HTTP layer with raw PNG bodies).

## How it works

- One Tesseract worker is created per language and reused across requests. The first call pays the init cost (~1.5s), later calls run at ~1s for a small image.
- A worker that errors or times out is terminated and rebuilt on the next request.
- Images are decoded to a `Buffer` in memory. Nothing is written to disk except the cached language data, so there is no temp-file cleanup and no unbounded disk growth.
- `npm start` exits cleanly on SIGINT/SIGTERM, terminating the worker threads.

## Notes

- `npm audit` reports 3 high-severity advisories, all from `braces` inside `nodemon` (dev file-watching only). Production deps audit clean, and no patched `braces` release exists yet.
- Tesseract tops out around 95%+ on clean printed text. For handwriting, forms or tables, use a cloud API (Google Cloud Vision, Azure AI Vision) — higher accuracy, per-page cost.
