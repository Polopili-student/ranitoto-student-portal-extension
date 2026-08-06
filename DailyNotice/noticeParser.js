import * as pdfjsLib from '../lib/pdf.mjs';

// use webworker to speedup the decode process
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

// to get all the bullet shape (as they are normally the used in a <ul>)
// "-" are excluded as in "Day 1 - Friday" it wouldn't work
export const BULLET_RE = /^\s*[\u2022\u25AA\u25E6\u2023\u00B7\uF0E4]/;

// if the blank at page bottom is less than this ratio, we say the page is full
const PAGE_FULL = 0.09;

// parse a Daily Notices pdf, return a list of blocks for the render layer to build DOM
// two kinds of block:
//   { kind: 'text',  tag: 'h1'|'h2'|'h3'|'p', segments: [{ str, bold }] }
//   { kind: 'image', dataUrl, widthRatio, imageKind: 'table'|'framed'|'image' }
export async function parseNotice(pdfUrl) {
    // pdfUrl example: 
    // https://www.rangitoto.school.nz/app/uploads/xxxx/xx/xxxxxxxx-xxxxx-xxxxxxx.pdf 
    const resp = await fetch(pdfUrl);
    // if resp is 404 or other, stop the function and throw a error
    if (!resp.ok) throw new Error(`Failed to download PDF (${resp.status})`);
    // use arrayBuffer as pdf is a binary file
    const arrayBuffer = await resp.arrayBuffer();
    // use .promise to get the result
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    // all the info in the pages
    const paragraphs = [];
    // to determine when to stop reading as one pdf contains two days
    let bannerCount = 0;
    // to determine whether the prev page has finished the block
    let prevPageFull = false;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        const bannerText = textContent.items
            // i.transform[3] >= 18 to filter the banner words
            .filter(i => Math.abs(i.transform[3]) >= 18)
            // get the actuarial word by using map and join them together
            .map(i => i.str).join('');
        // if title sized text contains "DAILY NOTICES", it is %99.99 a title banner 
        if (bannerText.includes('DAILY NOTICES')) {
            bannerCount++;
            if (bannerCount > 1) {
                console.log(`Page ${pageNum} onward belongs to another day; discarding`);
                break;   // stop when sees the prev day 
            }
        }

        // detectRegions calls getOperatorList(), which also registers the fonts into commonObjs
        // isBold below depends on it, so don't move it after
        const tableBoxes = await detectRegions(page, pageNum);

        // to get the placement of a link and it's url 
        const links = (await page.getAnnotations())
            .filter(a => a.subtype === 'Link' && (a.url || a.unsafeUrl))
            .map(a => ({ rect: a.rect, url: a.url || a.unsafeUrl }));
        const linkFor = item => {
            // if no link, skip
            if (!links.length) return null;
            const x = item.transform[4] + (item.width || 0) / 2;   // x mid of a word 
            const y = item.transform[5];                           // base line of a word
            const hit = links.find(l =>
                x >= l.rect[0] - 1 && x <= l.rect[2] + 1 && // 1 unit of tolerance
                y >= l.rect[1] - 1 && y <= l.rect[3] + 1);
            return hit ? hit.url : null;
        };

        // get the name of the font, then determine whether it is a bold font
        const boldCache = new Map();
        const isBoldFont = name => {
            if (!boldCache.has(name)) {
                let bold = false;
                try {
                    bold = /bold|black|heavy|semibold/i.test(page.commonObjs.get(name)?.name || '');
                } catch {
                    bold = false;   // no font, consider as none bold
                }
                boldCache.set(name, bold);
            }
            return boldCache.get(name);
        };

        // get the name of the emoji to prevent tofu block 𠆲
        const emojiCache = new Map();
        const isEmojiFont = name => {
            if (!emojiCache.has(name)) {
                let e = false;
                try {
                    e = /emoji|symbol|dingbat/i.test(page.commonObjs.get(name)?.name || '');
                }
                catch {
                    e = false;
                }
                emojiCache.set(name, e);
            }
            return emojiCache.get(name);
        };

        // slice the words into lines
        const lines = [];
        for (const it of textContent.items) {
            const size = Math.abs(it.transform[3]);
            if (!it.str.trim() || size >= 18) continue;   // discard banner words and blank
            const ly = it.transform[5];
            // if dif within 3px, then consider as one line 
            let L = lines.find(l => Math.abs(l.y - ly) < 3);
            // if it is a new line, create a new obj
            if (!L) {
                L = {
                    y: ly, 
                    right: -Infinity, 
                    size: 0
                }; 
                lines.push(L);
            }
            L.right = Math.max(L.right, it.transform[4] + (it.width || 0));
            L.size = Math.max(L.size, size);
        }
        lines.sort((a, b) => b.y - a.y);

        // add a margin to lines, so allow to sep the lines in paragraphs 
        for (let i = 0, start = 0; i < lines.length + 1; i++) {
            const gapHere = (i > 0 && i < lines.length) ? lines[i - 1].y - lines[i].y : Infinity;
            // if failed to get lines.size, then use 10
            const isEnd = (i === lines.length) || (gapHere >= (lines[i].size || 10) * 1.8);
            if (!isEnd) continue;
            const margin = Math.max(...lines.slice(start, i).map(l => l.right));
            for (let k = start; k < i; k++) lines[k].margin = margin;
            start = i;
        }

        const marginAt = y => lines.find(l => Math.abs(l.y - y) < 3)?.margin ?? 0;

        // to determine wether the line is a new paragraph, or just a word wrap
        const breaksParagraph = (item, lineHeight, prevY) => {
            const margin = marginAt(prevY);
            // if somehow the two args are invalid, return false, do not break
            if (!isFinite(lineRight) || !margin) return false;
            // get the space between the end of the prev line and the max length of that line 
            const room = margin - lineRight;
            // if the space is small enough, we say the prev line is filled
            // this line is not a new paragraph
            if (room <= 2) return false;       
            if (room < lineHeight * 2.5) return false; // double judge to make sure

            const s = item.str.trimStart();
            if (!s) return false;
            // split the word with any blank
            const word = s.split(/\s/)[0] || s;
            // a rough judge of the width of a word 
            const wordWidth = (item.width || 0) * (word.length / s.length);
            // if the space is enough to fit the word, but still breaks the line
            // we say it is a new paragraph
            return room > wordWidth * 1.15 + 2;       
        };

        let firstOnPage = true;      // haven't processed the page 
        let lineRight = -Infinity;   // the right margin of cur line 
        let lastY = null;
        let lastBold = null;   // if the prev el is bold 
        let segments = [];
        let maxSize = 0;
        // two seg to place the img
        let segStartY = null;
        let segEndY = null;
        // to determine wether the msg is placed as left and right 
        let segMinX = Infinity;
        let segMaxX = -Infinity;
        let segNewItem = true;
        // save the value fo the end of the img
        let afterBoxY = null;
        const emitted = new Set();

        function flush() {
            // when a text is ready in seg, push into paragraphs
            const fullText = segments.map(s => s.str).join('');
            if (fullText.trim()) {
                const allBold = segments.every(s => s.bold || s.str.trim() === '');
                // use slice for better robustness 
                paragraphs.push({
                    segments: segments.slice(), size: maxSize, allBold,
                    page: pageNum, y: segStartY, yEnd: segEndY, newItem: segNewItem,
                    minX: segMinX, maxX: segMaxX,
                });
            }
            segments = [];
            maxSize = 0;
            segStartY = null;
            segEndY = null;
            segMinX = Infinity;
            segMaxX = -Infinity;
            segNewItem = false;
        }

        textContent.items.forEach(item => {
            if (item.str === '') return;

            const y = item.transform[5];
            const fontSize = Math.abs(item.transform[3]);
            const lineHeight = fontSize || 10;
            // ignore the font change brought by emoji
            const isBold = isEmojiFont(item.fontName) && lastBold !== null
                ? lastBold : isBoldFont(item.fontName);

            // add a img
            const box = tableBoxes.find(b =>
                item.transform[4] >= b.minX && item.transform[4] <= b.maxX &&
                y >= b.minY && y <= b.maxY
            );
            if (box) {
                flush();                       // first flush the word out side the box
                if (!emitted.has(box)) {
                    emitted.add(box);
                    paragraphs.push({ image: box, page: pageNum, y: box.maxY });
                }
                lastY = null;
                lastBold = null;
                afterBoxY = box.minY;   // the base line of the img
                return;
            }

            const url = linkFor(item);

            // add a <li> tag to those with bullet points 
            const li = BULLET_RE.test(item.str);

            if (lastY !== null) {
                const gap = Math.abs(y - lastY);

                const headingEnds = 
                lastBold === true && 
                isBold === false &&
                segments.length > 0 && 
                segments.every(s => s.bold || !s.str.trim()) &&
                !/^[a-z]/.test(item.str.trimStart());

                if (gap < 3 && !headingEnds) {
                    segments.push({ str: item.str, bold: isBold, url, li });
                } else if (gap < lineHeight * 1.6 && !headingEnds && !breaksParagraph(item, lineHeight, lastY)) {
                    segments.push({ str: ' ' + item.str, bold: isBold, nl: true, url, li });
                } else {
                    flush();
                    segNewItem = gap >= lineHeight * 1.6;
                    segments.push({ str: item.str, bold: isBold, url, li });
                }
            } else {
                const continues =
                    // use the prev img's base line to measure the space
                    // if big enough, we say it is a new msg
                    (afterBoxY !== null && afterBoxY - y < lineHeight * 1.6)
                    // lower case == haven't finish the prev msg
                    || /^[a-z]/.test(item.str.trimStart())
                    // prev page is full + new page + non bold start == continues msg
                    || (firstOnPage && prevPageFull && !isBold);

                segNewItem = !continues;
                afterBoxY = null;
                segments.push({ str: item.str, bold: isBold, url, li });
            }

            if (segStartY === null) segStartY = y;
            segEndY = y;
            if (fontSize > maxSize) maxSize = fontSize;

            // same line == extend to the right, new line == start over from this word
            const right = item.transform[4] + (item.width || 0);
            lineRight = (lastY !== null && Math.abs(y - lastY) < 3)
                ? Math.max(lineRight, right) : right;

            // the left and right edge of the whole para, written into paragraph on flush
            if (item.transform[4] < segMinX) segMinX = item.transform[4];
            if (right > segMaxX) segMaxX = right;

            lastY = y;
            lastBold = isBold;   // update
            firstOnPage = false;
        });
        flush();   // this page is done

        // find the spot by y from top to bottom, so it goes where it should, not to the page end
        for (const b of tableBoxes) {
            if (emitted.has(b)) continue;
            let at = paragraphs.length;
            for (let k = 0; k < paragraphs.length; k++) {
                if (paragraphs[k].page === pageNum && paragraphs[k].y < b.maxY) { at = k; break; }
            }
            paragraphs.splice(at, 0, { image: b, page: pageNum, y: b.maxY });
        }

        // blank at page bottom less than 9% of the page height == the page is full
        const ys = textContent.items.filter(i => i.str.trim()).map(i => i.transform[5]);
        const pageH = page.getViewport({ scale: 1 }).height;
        const lowest = ys.length ? Math.min(...ys) : pageH;   // base line of the lowest line
        prevPageFull = ys.length > 0 && lowest <= pageH * PAGE_FULL;
    }

    // count the body font size, the img part below uses it as a ruler so do it first
    const sizeCount = {};
    paragraphs.forEach(p => {
        if (p.image) return;   // img has no font size, keep it out of the count
        const r = Math.round(p.size);
        sizeCount[r] = (sizeCount[r] || 0) + 1;
    });
    let bodySize = 0, maxCount = 0;
    for (const s in sizeCount) {
        if (sizeCount[s] > maxCount) { maxCount = sizeCount[s]; bodySize = Number(s); }
    }

    const lineH = bodySize || 10;
    const DESCENT = 0.25, ASCENT = 0.75;
    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        if (!p.image) continue;

        const near = (from, step) => {
            for (let k = from; k >= 0 && k < paragraphs.length; k += step) {
                const q = paragraphs[k];
                if (q.page !== p.page) break;
                if (!q.image) return q;
            }
            return null;
        };
        const prev = near(i - 1, -1);
        const next = near(i + 1, +1);

        const SIDE_TOL = 3;
        const sideOf = q => {
            if (q.image || q.page !== p.page) return false;
            if (q.size >= bodySize * 1.5) return false;  
            const qs = q.size || lineH;
            const overlap =
                Math.min(q.y + qs * ASCENT, p.image.maxY) -
                Math.max(q.yEnd - qs * DESCENT, p.image.minY);
            if (overlap < qs * 0.5) return false;
            return q.maxX < p.image.minX + SIDE_TOL || q.minX > p.image.maxX - SIDE_TOL;
        };
        const sideIdx = [];
        paragraphs.forEach((q, k) => { if (sideOf(q)) sideIdx.push(k); });
        if (sideIdx.length) {
            sideIdx.slice(1).forEach(k => { paragraphs[k].newItem = false; });
            p.attachNext = sideIdx[0] > i;
            console.log(
                `Page ${p.page} → image wrapped by ${sideIdx.length} paragraph(s) beside it, ` +
                `merging into one notice (image ${p.attachNext ? 'leads' : 'follows'})`
            );
            continue;
        }

        const above = prev
            ? (prev.yEnd - (prev.size || lineH) * DESCENT) - p.image.maxY
            : Infinity;
        const below = next
            ? p.image.minY - (next.y + (next.size || lineH) * ASCENT)
            : Infinity;

        const TIGHT = lineH * 0.6;

        if (!prev) {
            p.attachNext = below < TIGHT;
        } else if (above < TIGHT && below < TIGHT) {
            p.attachNext = false;
            if (next) next.newItem = false;
        } else {
            p.attachNext = below < above;
        }
    }

    // group them into blocks
    const blocks = [];
    let bannerSeen = false;

    for (const p of paragraphs) {
        if (p.image) {
            const regionPage = await pdf.getPage(p.page);
            const { dataUrl, width, height } = await renderRegionImage(regionPage, p.image);
            blocks.push({
                kind: 'image',
                dataUrl,
                imageKind: p.image.kind,
                // show it by the width ratio it takes in the pdf, so it lines up with the body
                widthRatio: Math.min(1, p.image.widthRatio),
                // raw pixel size, written into the width/height attr so the browser can
                // book the space early, or the masonry columns use a wrong height
                width, height,
                attachNext: !!p.attachNext,   // this img belongs to the msg below, not the one above
            });
            continue;
        }

        let tag;
        if (p.size >= bodySize * 1.5) tag = 'h1';
        else if (p.size >= bodySize * 1.15) tag = 'h2';
        else if (p.allBold) tag = 'h3';
        else tag = 'p';

        // the red banner on top and section titles like SENIORS / SPORT share the same
        // font size, both end up as h1. mark the banner here as the render layer treats
        // the two differently
        const fullText = p.segments.map(s => s.str).join('').trim();
        const isBanner = tag === 'h1' && fullText.includes('DAILY NOTICES');
        if (isBanner) {
            if (bannerSeen) break;
            bannerSeen = true;
        }

        blocks.push({ kind: 'text', tag, banner: isBanner, newItem: p.newItem, segments: p.segments });
    }

    return blocks;
}

function matMul(m1, m2) {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
}

function applyMatrixToBBox(bbox, m) {
    const pts = [
        [bbox[0], bbox[1]], [bbox[2], bbox[1]],
        [bbox[2], bbox[3]], [bbox[0], bbox[3]],
    ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
    };
}

function collectGeometry(ops) {
    const OPS = pdfjsLib.OPS;
    const paths = [];
    const images = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];

    for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];

        if (fn === OPS.save) {
            stack.push(ctm.slice());
        } else if (fn === OPS.restore) {
            if (stack.length) ctm = stack.pop();
        } else if (fn === OPS.transform) {
            ctm = matMul(ctm, args);
        } else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm.slice());
            if (args[0]) ctm = matMul(ctm, args[0]);   // the matrix of the form itself
        } else if (fn === OPS.paintFormXObjectEnd) {
            if (stack.length) ctm = stack.pop();
        } else if (fn === OPS.constructPath) {
            const bbox = args[2];
            if (!bbox) continue;
            const r = applyMatrixToBBox(bbox, ctm);
            r.w = r.maxX - r.minX;
            r.h = r.maxY - r.minY;
            r.op = args[0];        // fill / stroke / ... for debug
            paths.push(r);
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject ||
            fn === OPS.paintImageMaskXObject) {
            const r = applyMatrixToBBox([0, 0, 1, 1], ctm);   // unit square -> place on the page
            r.w = r.maxX - r.minX;
            r.h = r.maxY - r.minY;
            images.push(r);
        }
    }
    return { paths, images };
}

async function detectRegions(page, pageNum) {
    const ops = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });
    const pageW = viewport.width;
    const pageH = viewport.height;

    // the left and right edge of the body text, to tell a box in the body from a
    // full bleed header banner
    const textItems = (await page.getTextContent()).items.filter(i => i.str.trim());
    const bodyLeft = Math.min(...textItems.map(i => i.transform[4]));
    const bodyRight = Math.max(...textItems.map(i => i.transform[4] + (i.width || 0)));
    const bodyW = bodyRight - bodyLeft;

    const THIN = 4;      // how thin counts as a line
    const MIN_LEN = 25;  // how long counts as a meaningful line
    const GAP = 6;       // how close two lines count as connected

    const { paths, images } = collectGeometry(ops);

    // 1. sort them out: h line, v line, solid block (a header cell with a fill)
    const lines = [];
    for (const r of paths) {
        if (r.w > pageW * 0.9 && r.h > pageH * 0.9) continue;   // whole page background
        const isH = r.h <= THIN && r.w >= MIN_LEN;
        const isV = r.w <= THIN && r.h >= MIN_LEN;
        const isBlock = r.w >= MIN_LEN && r.h >= 8;            // filled cell
        if (isH || isV || isBlock) {
            lines.push({ ...r, kind: isH ? 'h' : isV ? 'v' : 'block' });
        }
    }

    // 2. group: union find the lines that touch (or almost touch) each other
    const parent = lines.map((_, i) => i);
    const find = a => parent[a] === a ? a : (parent[a] = find(parent[a]));
    const union = (a, b) => { parent[find(a)] = find(b); };

    const touches = (a, b) =>
        a.minX - GAP <= b.maxX && b.minX - GAP <= a.maxX &&
        a.minY - GAP <= b.maxY && b.minY - GAP <= a.maxY;

    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            if (touches(lines[i], lines[j])) union(i, j);
        }
    }

    const clusters = new Map();
    lines.forEach((l, i) => {
        const root = find(i);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(l);
    });

    // 3. decide
    // a real table must have inner lines, in both directions, crossing inside the box
    // only an outer frame == a text block with a border
    // only inner v lines and no inner h line == a header banner (one row, many columns)
    // this one tells banners and boxed paras from real tables cleanly
    const EDGE_TOL = 4;   // how close to the outer frame counts as the frame, not an inner line
    const boxes = [];

    for (const members of clusters.values()) {
        const box = {
            minX: Math.min(...members.map(m => m.minX)),
            minY: Math.min(...members.map(m => m.minY)),
            maxX: Math.max(...members.map(m => m.maxX)),
            maxY: Math.max(...members.map(m => m.maxY)),
            page: pageNum,
        };
        const boxW = box.maxX - box.minX;
        const boxH = box.maxY - box.minY;

        // too small (like a lonely underline) does not count
        if (boxW < 60 || boxH < 25) continue;

        // inner h line: Y not on the frame, and long enough to cross most of the box,
        // so a text underline is out
        const innerH = members.filter(m =>
            m.kind === 'h' &&
            m.minY > box.minY + EDGE_TOL && m.maxY < box.maxY - EDGE_TOL &&
            m.w >= boxW * 0.6
        ).length;

        // inner v line: same idea
        const innerV = members.filter(m =>
            m.kind === 'v' &&
            m.minX > box.minX + EDGE_TOL && m.maxX < box.maxX - EDGE_TOL &&
            m.h >= boxH * 0.6
        ).length;

        // fall back: some tables draw no line at all, they are made of filled cells
        // so check if the blocks make a matrix of at least 2 rows x 2 cols
        const blocks = members.filter(m => m.kind === 'block');
        const bands = (vals, tol) => {
            const sorted = [...vals].sort((a, b) => a - b);
            let n = 0, last = -Infinity;
            for (const v of sorted) if (v - last > tol) { n++; last = v; }
            return n;
        };
        const blockRows = bands(blocks.map(b => (b.minY + b.maxY) / 2), 6);
        const blockCols = bands(blocks.map(b => (b.minX + b.maxX) / 2), 6);

        // drop the header banner first: it is full bleed, wider than the body text on
        // both sides, and sits at the very top of the page
        // both are needed, position alone would kill a real table that sits high up
        const overflowsBody = box.minX < bodyLeft - 4 || box.maxX > bodyRight + 4;
        const atPageTop = box.maxY > pageH * 0.9;
        if (overflowsBody && atPageTop) {
            console.log(`Page ${pageNum} → skipping header banner, X ${box.minX.toFixed(0)}~${box.maxX.toFixed(0)}`);
            continue;
        }

        const isGrid = innerH >= 1 && innerV >= 1;
        const isBlockMatrix = blocks.length >= 4 && blockRows >= 2 && blockCols >= 2;

        // a single cell box counts as a table too: a whole para with a border or a
        // fill, plain text render would lose the whole look of it, so cut it as an img
        // judge by: four sides closed (or one whole backdrop) + width close to the body
        const nearEdge = (v, edge) => Math.abs(v - edge) <= EDGE_TOL;
        const hasFrame =
            members.some(m => m.kind === 'v' && nearEdge(m.minX, box.minX)) &&
            members.some(m => m.kind === 'v' && nearEdge(m.maxX, box.maxX)) &&
            members.some(m => m.kind === 'h' && nearEdge(m.maxY, box.maxY)) &&
            members.some(m => m.kind === 'h' && nearEdge(m.minY, box.minY));
        const hasBackdrop = blocks.some(b => b.w >= boxW * 0.9 && b.h >= boxH * 0.9);
        // there must be real words in the box, or it is only the backdrop of a picture
        // or a decoration, not a boxed para
        const hasText = textItems.some(i => {
            const x = i.transform[4], y = i.transform[5];
            return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
        });
        const isFramedBox = (hasFrame || hasBackdrop) && boxW >= bodyW * 0.5 && hasText;

        if (!isGrid && !isBlockMatrix && !isFramedBox) continue;

        box.kind = isGrid || isBlockMatrix ? 'table' : 'framed';
        box.widthRatio = boxW / bodyW;   // relative to the body width, shown by ratio
        boxes.push(box);
        console.log(
            `Page ${pageNum} → ${box.kind === 'table' ? 'table' : 'boxed block'}: ` +
            `X ${box.minX.toFixed(0)}~${box.maxX.toFixed(0)}, ` +
            `Y ${box.minY.toFixed(0)}~${box.maxY.toFixed(0)} ` +
            `(inner lines: ${innerH}h ${innerV}v, fill blocks: ${blockRows}x${blockCols})`
        );
    }

    // 4. pictures: the text only flow drops every img in the pdf, cut them in here
    for (const img of images) {
        if (img.w < 30 || img.h < 30) continue;              // small icon or decoration, skip
        // already inside a table or a boxed region, it gets cut with that block,
        // don't put it in twice
        const covered = boxes.some(b =>
            img.minX >= b.minX - 2 && img.maxX <= b.maxX + 2 &&
            img.minY >= b.minY - 2 && img.maxY <= b.maxY + 2
        );
        if (covered) continue;

        boxes.push({
            minX: img.minX, minY: img.minY, maxX: img.maxX, maxY: img.maxY,
            kind: 'image', widthRatio: img.w / bodyW, page: pageNum,
        });
        console.log(
            `Page ${pageNum} → image: X ${img.minX.toFixed(0)}~${img.maxX.toFixed(0)}, ` +
            `Y ${img.minY.toFixed(0)}~${img.maxY.toFixed(0)}`
        );
    }

    return boxes;
}

// cut a region into an img, return a data url ready to drop into <img>
async function renderRegionImage(page, box, scale = 2) {
    const viewport = page.getViewport({ scale });
    const PAD = scale;
    const [x1, y1] = viewport.convertToViewportPoint(box.minX, box.minY);
    const [x2, y2] = viewport.convertToViewportPoint(box.maxX, box.maxY);
    const left = Math.min(x1, x2) - PAD;
    const top = Math.min(y1, y2) - PAD;
    const w = Math.abs(x2 - x1) + PAD * 2;
    const h = Math.abs(y2 - y1) + PAD * 2;

    // render the whole page first, then crop
    const full = document.createElement('canvas');
    full.width = viewport.width;
    full.height = viewport.height;
    await page.render({ canvasContext: full.getContext('2d'), viewport }).promise;

    const crop = document.createElement('canvas');
    crop.width = Math.round(w);
    crop.height = Math.round(h);
    crop.getContext('2d').drawImage(full, left, top, w, h, 0, 0, w, h);

    return { dataUrl: crop.toDataURL('image/png'), width: w / scale, height: h / scale };
}
