const { PNG } = require('pngjs');

const GRID = 32;
const PADDING = 0.18;
const MIN_INK_PIXELS = 20;
const MIN_CONFIDENCE = Number(process.env.SYMBOL_MIN_CONFIDENCE || 65);

const ALPHA_INK = 40;
const ALPHA_OPAQUE = 250;
const HOLE_MIN_AREA = 0.02;

class SymbolError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'SymbolError';
        this.status = status;
        this.expose = true;
    }
}

function decodePng(buffer) {
    let png;
    try {
        png = PNG.sync.read(buffer);
    } catch {
        throw new SymbolError(
            'Unsupported image. Send PNG bytes (Unity: Texture2D.EncodeToPNG) as image/png or base64 JSON.',
            415
        );
    }
    if (!png.width || !png.height) {
        throw new SymbolError('Image has zero size.', 400);
    }
    return png;
}

function inkMask(png) {
    const { data, width, height } = png;
    const size = width * height;
    const mask = new Uint8Array(size);

    let hasTransparency = false;
    for (let i = 0; i < size; i++) {
        if (data[i * 4 + 3] < ALPHA_OPAQUE) {
            hasTransparency = true;
            break;
        }
    }

    if (hasTransparency) {
        for (let i = 0; i < size; i++) {
            mask[i] = data[i * 4 + 3] > ALPHA_INK ? 1 : 0;
        }
        return mask;
    }

    const luma = new Uint8Array(size);
    const hist = new Uint32Array(256);
    for (let i = 0; i < size; i++) {
        const l = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
        luma[i] = l;
        hist[l]++;
    }
    const threshold = otsu(hist, size);
    for (let i = 0; i < size; i++) {
        mask[i] = luma[i] <= threshold ? 1 : 0;
    }
    return mask;
}

function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let sumB = 0;
    let weightB = 0;
    let best = 0;
    let bestVariance = -1;

    for (let t = 0; t < 256; t++) {
        weightB += hist[t];
        if (weightB === 0) continue;
        const weightF = total - weightB;
        if (weightF === 0) break;

        sumB += t * hist[t];
        const meanB = sumB / weightB;
        const meanF = (sum - sumB) / weightF;
        const variance = weightB * weightF * (meanB - meanF) ** 2;

        if (variance > bestVariance) {
            bestVariance = variance;
            best = t;
        }
    }
    return best;
}

function boundingBox(mask, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let ink = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            ink++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }

    if (ink < MIN_INK_PIXELS || maxX < 0) {
        throw new SymbolError('No drawing detected on the canvas.', 422);
    }
    return { minX, minY, maxX, maxY, ink };
}

function normalize(mask, width, height, box) {
    const w = box.maxX - box.minX + 1;
    const h = box.maxY - box.minY + 1;
    const size = Math.max(w, h);
    const originX = box.minX - (size - w) / 2 - size * PADDING;
    const originY = box.minY - (size - h) / 2 - size * PADDING;
    const span = size * (1 + PADDING * 2);

    const grid = new Uint8Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++) {
        const y0 = originY + (gy * span) / GRID;
        const y1 = originY + ((gy + 1) * span) / GRID;
        for (let gx = 0; gx < GRID; gx++) {
            const x0 = originX + (gx * span) / GRID;
            const x1 = originX + ((gx + 1) * span) / GRID;
            const sy0 = Math.max(0, Math.floor(y0));
            const sy1 = Math.min(height, Math.ceil(y1));
            const sx0 = Math.max(0, Math.floor(x0));
            const sx1 = Math.min(width, Math.ceil(x1));

            let on = 0;
            for (let y = sy0; y < sy1; y++) {
                for (let x = sx0; x < sx1; x++) {
                    on += mask[y * width + x];
                }
            }
            grid[gy * GRID + gx] = on > 0 ? 1 : 0;
        }
    }
    return grid;
}

function regionFill(grid, inRegion) {
    let sum = 0;
    let count = 0;
    for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
            if (!inRegion(gx / GRID, gy / GRID)) continue;
            sum += grid[gy * GRID + gx];
            count++;
        }
    }
    return count ? sum / count : 0;
}

function holeFraction(grid) {
    const seen = new Uint8Array(GRID * GRID);
    const stack = [];

    const flood = (x, y) => {
        if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
        const i = y * GRID + x;
        if (seen[i] || grid[i]) return;
        seen[i] = 1;
        stack.push(i);
    };

    for (let x = 0; x < GRID; x++) {
        flood(x, 0);
        flood(x, GRID - 1);
    }
    for (let y = 0; y < GRID; y++) {
        flood(0, y);
        flood(GRID - 1, y);
    }
    while (stack.length) {
        const i = stack.pop();
        flood((i % GRID) + 1, Math.floor(i / GRID));
        flood((i % GRID) - 1, Math.floor(i / GRID));
        flood(i % GRID, Math.floor(i / GRID) + 1);
        flood(i % GRID, Math.floor(i / GRID) - 1);
    }

    let enclosed = 0;
    for (let i = 0; i < grid.length; i++) {
        if (!seen[i] && !grid[i]) enclosed++;
    }
    return enclosed / grid.length;
}

function features(grid) {
    return {
        center: regionFill(grid, (u, v) => u >= 0.44 && u <= 0.56 && v >= 0.44 && v <= 0.56),
        corners: regionFill(
            grid,
            (u, v) => (u < 0.22 || u > 0.78) && (v < 0.22 || v > 0.78)
        ),
        edges: regionFill(grid, (u, v) => {
            const midU = u >= 0.4 && u <= 0.6;
            const midV = v >= 0.4 && v <= 0.6;
            const edgeU = u < 0.25 || u > 0.75;
            const edgeV = v < 0.25 || v > 0.75;
            return (midU && edgeV) || (midV && edgeU);
        }),
        holes: holeFraction(grid),
    };
}

function classify(f) {
    const hasHole = f.holes > HOLE_MIN_AREA ? 1 : 0;

    const xScore = 0.3 * f.center + 0.45 * f.corners + 0.25 * (1 - f.edges);
    const oScore = 0.35 * hasHole + 0.35 * (1 - f.center) + 0.2 * f.edges + 0.1 * (1 - f.corners);

    const total = xScore + oScore;
    const isCross = xScore > oScore;
    const confidence = total ? Math.round((Math.max(xScore, oScore) / total) * 100) : 50;

    return {
        result: isCross ? 1 : 0,
        label: isCross ? 'X' : 'O',
        confidence,
        needsRetry: confidence < MIN_CONFIDENCE,
    };
}

function classifyPng(buffer) {
    const png = decodePng(buffer);
    const mask = inkMask(png);
    const box = boundingBox(mask, png.width, png.height);
    const grid = normalize(mask, png.width, png.height, box);
    const f = features(grid);

    return {
        ...classify(f),
        features: {
            center: round2(f.center),
            corners: round2(f.corners),
            edges: round2(f.edges),
            holes: round2(f.holes),
        },
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = { classifyPng, SymbolError };
