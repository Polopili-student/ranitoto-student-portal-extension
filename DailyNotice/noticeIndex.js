// where to get all the urls 
const INDEX_URL =
    'https://www.rangitoto.school.nz/parents-students/communications/daily-notices/';

const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAYS = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
};

// how the link note could looks: 
//   "Monday 20th July – Day 2"
//   "Friday 13th March 2026 – Day 6"
//   "Monday 16th February 2026"
const ENTRY_RE = new RegExp(
    String.raw`(${Object.keys(WEEKDAYS).join('|')})\s+` +  // days of the week e.g. sunday
    String.raw`(\d{1,2})(?:st|nd|rd|th)?\s+` +             // date e.g. 20th
    String.raw`([a-z]{3,})\.?` +                           // month e.g. July (could be not there)
    String.raw`(?:\s+(\d{4}))?`,                           // years e.g. 2026 (could be not there)
    'i',
);

const TERM_RE = /\b(20\d{2})\b[^\d]{0,20}\bterm\s*(\d)\b/i;

const DAY_RE = /\bday\s*(\d)\b/i;

// return format: [{ key, date, url, weekday, cycleDay, term, year }]
export async function fetchNoticeIndex() {
    const resp = await fetch(INDEX_URL);
    if (!resp.ok) throw new Error(`Index page returned ${resp.status}`);

    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');

    let year = null;
    let term = null;
    const byKey = new Map();
    const problems = [];

    for (const el of doc.body.querySelectorAll('*')) {
        if (!el.children.length) {
            const m = (el.textContent || '').match(TERM_RE);
            if (m) { year = +m[1]; term = +m[2]; continue; }
        }

        if (el.tagName !== 'A') continue;
        const raw = el.getAttribute('href');
        if (!raw) continue;
        const url = new URL(raw, INDEX_URL).href;
        if (!/\.pdf(\?|$)/i.test(url)) continue;

        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const entry = parseEntry(text, year, term, url, problems);
        if (entry && !byKey.has(entry.key)) byKey.set(entry.key, entry);
    }

    if (problems.length) {
        console.warn(`${problems.length} entr${problems.length === 1 ? "y" : "ies"} on the index page needed attention:`, problems);
    }

    const list = [...byKey.values()].sort((a, b) => b.key.localeCompare(a.key));
    if (!list.length) throw new Error('No notice links found on the index page');
    return list;
}

function parseEntry(text, panelYear, term, url, problems) {
    const m = text.match(ENTRY_RE);
    if (!m) {
        return null;
    }

    const day = +m[2];
    const month = MONTHS[m[3].slice(0, 3).toLowerCase()];
    // if "years" are in the text , else use the panel's year
    const year = m[4] ? +m[4] : panelYear;

    if (!month || !year) {
        problems.push(`${text} — ${!month ? 'unrecognised month' : 'no year available'}`);
        return null;
    }

    const date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day) {
        problems.push(`${text} — not a real calendar date`);
        return null;
    }

    const stated = WEEKDAYS[m[1].toLowerCase()];
    let final = date;

    if (date.getDay() !== stated) {
        const alt = dateFromFilename(url);
        if (alt && alt.getDay() === stated &&
            alt.getFullYear() === year && alt.getMonth() === month - 1) {
            problems.push(`${text} — day number is wrong; corrected to ${fmt(alt)} from the filename`);
            final = alt;
        } else {
            problems.push(`${text} — weekday mismatch and the filename does not resolve it; keeping the text date`);
        }
    }

    const cycle = text.match(DAY_RE);

    return {
        key: fmt(final),
        date: final,
        url,
        weekday: final.getDay(),
        cycleDay: cycle ? +cycle[1] : null, 
        term,
        year,
    };
}

function dateFromFilename(url) {
    const m = url.match(/(20\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const date = new Date(y, mo - 1, d);
    if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date;
}

function fmt(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}