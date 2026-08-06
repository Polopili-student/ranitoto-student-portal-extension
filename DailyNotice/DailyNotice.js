import { fetchNoticeIndex } from './noticeIndex.js';
import { parseNotice, BULLET_RE } from './noticeParser.js';

const els = {
    list: document.getElementById('date-list'),
    output: document.getElementById('output'),
    date: document.getElementById('current-date'),
    weekday: document.getElementById('current-weekday'),
    pdf: document.getElementById('open-pdf'),
    toggle: document.getElementById('toggle-sidebar'),
    root: document.querySelector('.layout'),
    sidebar: document.querySelector('.sidebar'),
};

let entries = [];
let current = -1;

const cache = new Map();      // key -> blocks
const inFlight = new Map();   // key -> Promise<blocks> 

let renderSeq = 0;

let layout = null;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = MONTH_NAMES.map(m => m.slice(0, 3));

init();

async function init() {
    els.toggle.addEventListener('click', () => {
        const hidden = els.root.classList.toggle('sidebar-hidden');
        els.toggle.setAttribute('aria-expanded', String(!hidden));
        els.toggle.title = hidden ? 'Show list' : 'Hide list';
        els.toggle.textContent = hidden ? '\u00BB' : '\u00AB';
        els.sidebar.toggleAttribute('inert', hidden);
    });

    // wait for the animation to finnish
    els.sidebar.addEventListener('transitionend', e => {
        if (e.propertyName === 'margin-left') applyLayout();
    });

    // if the the screen size has changed, resize
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(applyLayout, 150);
    });

    // arrow key to change date 
    document.addEventListener('keydown', keyPressed => {
        if (keyPressed.target.matches('input, textarea')) return;
        if (keyPressed.key === 'ArrowLeft' || keyPressed.key === 'ArrowDown') { keyPressed.preventDefault(); step(+1); }
        if (keyPressed.key === 'ArrowRight' || keyPressed.key === 'ArrowUp') { keyPressed.preventDefault(); step(-1); }
    });

    await loadIndex();
}

async function loadIndex() {
    // loading hint
    els.list.innerHTML = '<p class="sidebar-hint">Fetching…</p>';

    try {
        entries = await fetchNoticeIndex();
    } catch (err) {
        console.error(err);
        els.list.innerHTML = '';
        els.list.appendChild(message('error', "Can't load the date list", err.message));
        showState('error', "Can't load the date list", 'Fetching the notices index page failed.');
        return;
    }

    renderDateList();
    select(pickDefault());
}

function pickDefault() {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    const exact = entries.findIndex(e => e.key === todayKey);
    return exact === -1 ? 0 : exact;   
}

function renderDateList() {
    els.list.innerHTML = '';
    let items = null;
    let lastGroup = '';

    entries.forEach((entry, i) => {
        const d = entry.date;
        const label = entry.term ? `Term ${entry.term} ${entry.year}` : String(entry.year);
        if (label !== lastGroup) {
            items = openGroup(label);
            lastGroup = label;
        }

        const btn = document.createElement('button');
        btn.className = 'date-item';
        btn.dataset.index = i;
        btn.innerHTML =
            `<span class="date-day">${d.getDate()} ${MONTH_SHORT[d.getMonth()]}</span>` +
            `<span class="date-weekday">${WEEKDAYS[d.getDay()]}</span>`;
        btn.addEventListener('click', () => select(i));
        items.appendChild(btn);
    });
}

function openGroup(label) {
    const group = document.createElement('div');
    group.className = 'group collapsed';

    const head = document.createElement('button');
    head.className = 'group-label';
    head.setAttribute('aria-expanded', 'false');
    head.innerHTML = `<span class="chev">▾</span><span>${label}</span>`;

    const items = document.createElement('div');
    items.className = 'group-items';

    head.addEventListener('click', () => {
        const collapsed = group.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
    });

    group.append(head, items);
    els.list.appendChild(group);
    return items;
}

function markActive() {
    els.list.querySelectorAll('.date-item').forEach(b => {
        const on = Number(b.dataset.index) === current;
        b.classList.toggle('active', on);
        if (!on) return;

        const group = b.closest('.group');
        if (group?.classList.contains('collapsed')) {
            group.classList.remove('collapsed');
            group.querySelector('.group-label')?.setAttribute('aria-expanded', 'true');
        }
        b.scrollIntoView({ block: 'nearest' });
    });
}

function step(delta) {
    const next = current + delta;
    if (next >= 0 && next < entries.length) select(next);
}

// load one day 
async function select(index) {
    // filter for valid index
    if (index < 0 || index >= entries.length) return;

    current = index;
    const entry = entries[index];
    const seq = ++renderSeq;

    // load the header fist 
    els.date.textContent = formatDate(entry.date);
    els.weekday.textContent = [
        WEEKDAYS[entry.date.getDay()],
        entry.term ? `Term ${entry.term}` : null,
        entry.cycleDay ? `Day ${entry.cycleDay}` : null,
    ].filter(Boolean).join(' ');
    els.pdf.href = entry.url;
    els.pdf.hidden = false;
    markActive();

    if (cache.has(entry.key)) {
        renderBlocks(cache.get(entry.key));
        return;
    }

    showState('loading', 'Parsing notice…', entry.url.split('/').pop());

    try {
        const blocks = await loadBlocks(entry);
        if (seq !== renderSeq) return;   
        renderBlocks(blocks);
    } catch (err) {
        console.error(err);
        if (seq !== renderSeq) return;
        showState('error', "Can't open this day's notice", err.message);
    }
}

function loadBlocks(entry) {
    if (inFlight.has(entry.key)) return inFlight.get(entry.key);

    const p = parseNotice(entry.url)
        .then(blocks => {
            cache.set(entry.key, blocks);
            return blocks;
        })
        .finally(() => inFlight.delete(entry.key));

    inFlight.set(entry.key, p);
    return p;
}

function renderBlocks(blocks) {
    if (!blocks.length) {
        showState('empty', 'Nothing in this notice', 'The PDF parsed to an empty document.');
        return;
    }

    const bannerParts = [];
    const metaParts = [];
    const sections = [];    // [{ title: element|null, cards: [element] }]
    let section = null;
    let card = null;

    const openSection = titleBlock => {
        let title = null;
        if (titleBlock) {
            title = document.createElement('h2');
            title.className = 'section-title';
            fillSegments(title, titleBlock.segments);
        }
        section = { title, cards: [] };
        sections.push(section);
        card = null;
    };

    const openCard = titleBlock => {
        if (!section) openSection(null);

        const reuse = card && !card.querySelector('.card-title, .notice-body');
        if (!reuse) {
            card = document.createElement('article');
            card.className = 'card';
            section.cards.push(card);
        }

        if (titleBlock) {
            const h = document.createElement('h3');
            h.className = 'card-title';
            fillSegments(h, titleBlock.segments);
            card.insertBefore(h, card.firstChild);   
        }
    };

    const body = () => (card || (openCard(null), card));

    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];

        if (b.kind === 'image') {
            const next = blocks[i + 1];
            const nextIsNewItem = next && next.kind === 'text' && (next.newItem || next.tag === 'h3');
            if (b.attachNext && nextIsNewItem && card && card.childNodes.length) openCard(null);

            const img = document.createElement('img');
            img.src = b.dataUrl;
            img.className = 'notice-' + b.imageKind;
            img.alt = { table: 'Table', framed: 'Boxed content', image: 'Image' }[b.imageKind];
            // 按它在 PDF 正文里占的宽度比例显示，小图标不至于被撑成整栏宽
            img.style.width = (b.widthRatio * 100).toFixed(1) + '%';
            if (b.width && b.height) {
                img.width = Math.round(b.width);
                img.height = Math.round(b.height);
            }
            body().appendChild(img);
            continue;
        }

        if (b.banner) { bannerParts.push(b); continue; }
        if (b.tag === 'h2') { metaParts.push(b); continue; }

        if (b.tag === 'h1') { openSection(b); continue; }

        if (b.tag === 'h3' && (b.newItem || !card || !card.childNodes.length)) {
            openCard(b);
            continue;
        }

        if (b.newItem && card && card.childNodes.length) openCard(null);

        appendBody(body(), b.segments);
    }

    const head = [];
    if (bannerParts.length) head.push(buildHeadPart('notice-banner', bannerParts));
    if (metaParts.length) head.push(buildHeadPart('notice-meta', metaParts));

    layout = { head, sections };
    applyLayout();
    els.output.scrollTop = 0;
}

function buildHeadPart(cls, blocks) {
    const el = document.createElement('div');
    el.className = cls;
    blocks.forEach((b, i) => {
        if (i > 0) el.appendChild(document.createElement('br'));
        fillSegments(el, b.segments, { lineBreaks: true });
    });
    return el;
}

function applyLayout() {
    if (!layout) return;

    const inner = document.createElement('div');
    inner.className = 'notice-inner';
    if (layout.head.length) {
        const head = document.createElement('header');
        head.className = 'notice-head';
        layout.head.forEach(el => head.appendChild(el));
        inner.appendChild(head);
    }

    els.output.innerHTML = '';
    els.output.appendChild(inner);

    const MIN_COL = 440, GAP = 22.5;
    const avail = inner.clientWidth;
    const n = Math.max(1, Math.min(4, Math.floor((avail + GAP) / (MIN_COL + GAP))));

    for (const sec of layout.sections) {
        const el = document.createElement('section');
        el.className = 'section';
        if (sec.title) el.appendChild(sec.title);

        const wrap = document.createElement('div');
        wrap.className = 'cards';
        const cols = [];
        for (let i = 0; i < n; i++) {
            const c = document.createElement('div');
            c.className = 'col';
            wrap.appendChild(c);
            cols.push(c);
        }
        el.appendChild(wrap);
        inner.appendChild(el);

        for (const c of sec.cards) {
            let best = cols[0];
            for (const col of cols) if (col.offsetHeight < best.offsetHeight) best = col;
            best.appendChild(c);
        }
    }
}

function fillSegments(el, segments, { strong = false, lineBreaks = false } = {}) {
    segments.forEach((seg, i) => {
        if (lineBreaks && seg.nl && i > 0) el.appendChild(document.createElement('br'));
        const text = lineBreaks && seg.nl ? seg.str.replace(/^ /, '') : seg.str;

        let node = el;
        if (strong && seg.bold) {
            node = document.createElement('strong');
            el.appendChild(node);
        }

        if (seg.url) {
            const a = document.createElement('a');
            a.href = seg.url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.className = 'notice-link';
            a.textContent = text;
            node.appendChild(a);
        } else {
            appendTextWithLinks(node, text);
        }
    });
}

function appendBody(parent, segments) {
    let list = null;  
    let para = null;  

    const flushPara = () => { para = null; };

    for (const seg of segments) {
        if (seg.li) {
            flushPara();
            if (!list) {
                list = document.createElement('ul');
                list.className = 'notice-list';
                parent.appendChild(list);
            }
            const item = document.createElement('li');
            const rest = seg.str.replace(BULLET_RE, '');
            if (rest.trim()) fillSegments(item, [{ ...seg, str: rest.trimStart() }], { strong: true });
            list.appendChild(item);
            continue;
        }

        if (list && !seg.nl) {
            const li = list.lastElementChild;
            const text = li.childNodes.length ? seg.str : seg.str.trimStart();
            fillSegments(li, [{ ...seg, str: text }], { strong: true });
            continue;
        }

        list = null;
        if (!para) {
            para = document.createElement('p');
            para.className = 'notice-body';
            parent.appendChild(para);
        }
        fillSegments(para, [seg], { strong: true });
    }
}

function showState(kind, title, detail) {
    layout = null;  
    els.output.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'notice-inner';
    inner.appendChild(message(kind, title, detail));
    els.output.appendChild(inner);
}

function message(kind, title, detail) {
    const box = document.createElement('div');
    box.className = 'state state-' + kind;
    if (kind === 'loading') {
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        box.appendChild(spinner);
    }

    const h = document.createElement('p');
    h.className = 'state-title';
    h.textContent = title;
    box.appendChild(h);

    if (detail) {
        const p = document.createElement('p');
        p.className = 'state-detail';
        p.textContent = detail;
        box.appendChild(p);
    }
    return box;
}

function formatDate(d) {
    return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function appendTextWithLinks(parent, text) {
    // to match url start with https
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = urlRegex.exec(text)) !== null) {
        // the text before url 
        if (match.index > lastIndex) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }
        const a = document.createElement('a');
        a.href = match[0];
        a.textContent = match[0];
        a.target = '_blank';      // open in new page
        a.className = 'notice-link';
        parent.appendChild(a);

        lastIndex = urlRegex.lastIndex;
    }
    // the text behind the url
    if (lastIndex < text.length) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
}