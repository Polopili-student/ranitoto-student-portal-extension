(function () {
    const STORAGE_KEY = "customProfilePic";
    const SHAPE_KEY = "profilePicShape";
    const PRIVACY_KEY = "maskedFields";
    const PIC_SELECTOR = "#img_srch_student, .text-left img";
    const SQUARE_RADIUS = "0";            // bump to e.g. "6px" for softened corners
    const MAX_EDGE = 512;                 // longest edge kept after downscaling
    const MAX_FILE_SIZE = 8 * 1024 * 1024;

    // Each value on the page lives in span.lbl_student_<key>
    const PRIVACY_FIELDS = [
        { key: "student_name", label: "Student Name" },
        { key: "regno", label: "Registration Number" },
        { key: "exam_number", label: "NSN Number" },
        { key: "barcode", label: "ID Number" },
        { key: "gender", label: "Gender" },
        { key: "current_year", label: "Year" },
        { key: "age", label: "Age" },
        { key: "birthdate", label: "Birth Date" },
        { key: "email", label: "Email" },
        { key: "mobile", label: "Mobile" },
        { key: "home_room", label: "Home Room" },
        { key: "house", label: "House" },
        { key: "home_class", label: "Home Class" },
        { key: "home_teacher", label: "Home Teacher" },
        { key: "dean", label: "Dean" },
        { key: "status", label: "Status" },
    ];

    const style = document.createElement("style");
    document.head.appendChild(style);

    // No saved picture = no content override at all, so the page shows its own.
    // `img#...` outranks the stylesheet's `#img_srch_student` rule, so the shape
    // wins regardless of injection order.
    function renderStyle() {
        const rules = [];
        if (saved) rules.push(`${PIC_SELECTOR} { content: url("${saved}"); }`);
        rules.push(`img#img_srch_student { border-radius: ${shape === "square" ? SQUARE_RADIUS : "50%"} !important; }`);
        style.textContent = rules.join("\n");
    }

    // `content:` never touches the src attribute, so this stays the site's own image
    function originalPicSrc() {
        const img = document.querySelector(PIC_SELECTOR);
        return img ? (img.currentSrc || img.src || "") : "";
    }

    const customPage = document.createElement("div");
    customPage.id = "panel";
    customPage.className = "floating-panel";
    customPage.innerHTML =
        `
        <div class="panel-header">
            <span>Custom Setting</span>
            <button class="close-btn" id="closeBtn">×</button>
        </div>
        <div class="panel-body">
            <div class="panel-content">
                <div class="setting-section">
                    <div class="setting-title">Profile Picture</div>
                    <div class="setting-desc">Upload your own image to replace the photo shown on this page.</div>

                    <div class="pic-setting">
                        <div class="pic-preview-wrap">
                            <img class="pic-preview" id="picPreview" alt="">
                            <span class="pic-preview-label">Preview</span>
                        </div>

                        <div class="drop-zone" id="dropZone" tabindex="0" role="button">
                            <svg class="drop-icon" width="28" height="28" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="17 8 12 3 7 8"/>
                                <line x1="12" y1="3" x2="12" y2="15"/>
                            </svg>
                            <div class="drop-text"><strong>Click to choose</strong> or drag an image here</div>
                            <div class="drop-hint">JPG · PNG · WEBP · GIF, up to 8 MB</div>
                            <input type="file" class="pic-input" id="picInput" accept="image/*">
                        </div>
                    </div>

                    <div class="setting-actions">
                        <button class="pic-btn pic-btn-primary" id="picSave" disabled>Save</button>
                        <button class="pic-btn pic-btn-ghost" id="picReset">Use original picture</button>
                        <span class="setting-status" id="picStatus"></span>
                    </div>
                </div>

                <div class="setting-section">
                    <div class="setting-title">Picture Shape</div>
                    <div class="setting-desc">Applies to the large photo at the top of this page.</div>

                    <div class="shape-options" id="shapeOptions">
                        <button class="shape-btn" data-shape="circle">
                            <span class="shape-swatch shape-swatch-circle"></span>
                            <span>Circle</span>
                        </button>
                        <button class="shape-btn" data-shape="square">
                            <span class="shape-swatch shape-swatch-square"></span>
                            <span>Square</span>
                        </button>
                    </div>
                </div>

                <div class="setting-section">
                    <div class="setting-title">Privacy</div>
                    <div class="setting-desc">Cover the selected details with asterisks. Hover over a covered value to read it again.</div>

                    <div class="priv-actions">
                        <button class="priv-link" id="privAll">Select all</button>
                        <span class="priv-sep">·</span>
                        <button class="priv-link" id="privNone">Clear</button>
                    </div>

                    <div class="priv-grid">
                        ${PRIVACY_FIELDS.map(f => `
                        <label class="priv-item">
                            <input type="checkbox" class="priv-check" data-field="${f.key}">
                            <span>${f.label}</span>
                        </label>`).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(customPage);
    const panel = customPage;

    customPage.querySelector('#closeBtn').addEventListener('click', () => {
        customPage.classList.remove('is-open');
    });

    /* ---------- profile picture upload ---------- */
    const preview = customPage.querySelector('#picPreview');
    const dropZone = customPage.querySelector('#dropZone');
    const input = customPage.querySelector('#picInput');
    const saveBtn = customPage.querySelector('#picSave');
    const resetBtn = customPage.querySelector('#picReset');
    const status = customPage.querySelector('#picStatus');
    const shapeBtns = [...customPage.querySelectorAll('.shape-btn')];
    const privChecks = [...customPage.querySelectorAll('.priv-check')];

    let saved = null;         // data URL currently applied to the page
    let pending = null;       // data URL waiting to be saved
    let shape = "circle";     // "circle" | "square"
    let masked = new Set();   // field keys currently covered

    // Falls back to whatever the page itself is showing.
    function showPreview(url) {
        const src = url || originalPicSrc();
        if (src) preview.src = src;
        else preview.removeAttribute('src');
    }

    function showShape() {
        shapeBtns.forEach(b => b.classList.toggle('is-active', b.dataset.shape === shape));
        preview.classList.toggle('is-square', shape === "square");
    }

    function showMasks() {
        privChecks.forEach(c => { c.checked = masked.has(c.dataset.field); });
    }

    // The page text is never rewritten — an ::after overlay sits on top of it,
    // so nothing is lost and a re-render can't leave stale asterisks behind.
    function applyMasks() {
        PRIVACY_FIELDS.forEach(f => {
            const on = masked.has(f.key);
            document.querySelectorAll('.lbl_student_' + f.key).forEach(el => {
                if (!on) {
                    el.classList.remove('priv-masked');
                    el.removeAttribute('data-mask');
                    return;
                }
                const len = el.textContent.trim().length;
                if (!len) return;
                el.dataset.mask = '*'.repeat(Math.min(Math.max(len, 3), 24));
                el.classList.add('priv-masked');
            });
        });
    }

    showPreview(null);
    showShape();
    renderStyle();

    chrome.storage.local.get([STORAGE_KEY, SHAPE_KEY, PRIVACY_KEY], res => {
        saved = res[STORAGE_KEY] || null;
        shape = res[SHAPE_KEY] === "square" ? "square" : "circle";
        masked = new Set(Array.isArray(res[PRIVACY_KEY]) ? res[PRIVACY_KEY] : []);
        showShape();
        showMasks();
        renderStyle();
        applyMasks();
        if (saved) showPreview(saved);
    });

    privChecks.forEach(check => {
        check.addEventListener('change', () => {
            if (check.checked) masked.add(check.dataset.field);
            else masked.delete(check.dataset.field);
            applyMasks();   // takes effect straight away, no Save needed
            chrome.storage.local.set({ [PRIVACY_KEY]: [...masked] });
        });
    });

    function setAllMasks(on) {
        masked = new Set(on ? PRIVACY_FIELDS.map(f => f.key) : []);
        showMasks();
        applyMasks();
        chrome.storage.local.set({ [PRIVACY_KEY]: [...masked] });
    }

    customPage.querySelector('#privAll').addEventListener('click', () => setAllMasks(true));
    customPage.querySelector('#privNone').addEventListener('click', () => setAllMasks(false));

    shapeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.shape === shape) return;
            shape = btn.dataset.shape;
            showShape();
            renderStyle();   // shape applies straight away, no Save needed
            chrome.storage.local.set({ [SHAPE_KEY]: shape });
        });
    });

    function setStatus(text, kind) {
        status.textContent = text;
        status.className = 'setting-status' + (kind ? ' is-' + kind : '');
    }

    // Shrink to MAX_EDGE and re-encode, so storage stays small and the page paints fast.
    function shrink(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("Could not read that file."));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error("That file is not a valid image."));
                img.onload = () => {
                    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.round(img.width * scale));
                    canvas.height = Math.max(1, Math.round(img.height * scale));

                    const ctx = canvas.getContext("2d");
                    ctx.fillStyle = "#fff";   // transparent areas would turn black in JPEG
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    resolve(canvas.toDataURL("image/jpeg", 0.9));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function handleFile(file) {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setStatus("Please choose an image file.", "error");
            return;
        }
        if (file.size > MAX_FILE_SIZE) {
            setStatus("That image is larger than 8 MB.", "error");
            return;
        }

        setStatus("Processing…");
        shrink(file).then(dataUrl => {
            pending = dataUrl;
            preview.src = dataUrl;
            saveBtn.disabled = false;
            setStatus("Ready — click Save to apply.");
        }).catch(err => {
            pending = null;
            saveBtn.disabled = true;
            setStatus(err.message, "error");
        });
    }

    dropZone.addEventListener('click', () => input.click());
    dropZone.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.click();
        }
    });

    input.addEventListener('change', () => {
        handleFile(input.files[0]);
        input.value = '';   // allow re-picking the same file
    });

    ['dragenter', 'dragover'].forEach(type => {
        dropZone.addEventListener(type, e => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('is-dragover');
        });
    });
    ['dragleave', 'drop'].forEach(type => {
        dropZone.addEventListener(type, e => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('is-dragover');
        });
    });
    dropZone.addEventListener('drop', e => {
        handleFile(e.dataTransfer.files[0]);
    });

    saveBtn.addEventListener('click', () => {
        if (!pending) return;
        const dataUrl = pending;
        saveBtn.disabled = true;
        setStatus("Saving…");
        chrome.storage.local.set({ [STORAGE_KEY]: dataUrl }, () => {
            if (chrome.runtime.lastError) {
                saveBtn.disabled = false;
                setStatus("Could not save: " + chrome.runtime.lastError.message, "error");
                return;
            }
            pending = null;
            saved = dataUrl;
            renderStyle();
            setStatus("Saved.", "ok");
        });
    });

    resetBtn.addEventListener('click', () => {
        chrome.storage.local.remove(STORAGE_KEY, () => {
            pending = null;
            saveBtn.disabled = true;
            saved = null;
            renderStyle();
            showPreview(null);
            setStatus("Showing the page's original picture.", "ok");
        });
    });

    // keep other open tabs of this page in sync
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes[STORAGE_KEY]) {
            saved = changes[STORAGE_KEY].newValue || null;
            if (!pending) showPreview(saved);
        }
        if (changes[SHAPE_KEY]) {
            shape = changes[SHAPE_KEY].newValue === "square" ? "square" : "circle";
            showShape();
        }
        if (changes[PRIVACY_KEY]) {
            const next = changes[PRIVACY_KEY].newValue;
            masked = new Set(Array.isArray(next) ? next : []);
            showMasks();
            applyMasks();
        }
        if (changes[STORAGE_KEY] || changes[SHAPE_KEY]) renderStyle();
    });

    (function () {
        function addIcon() {
            const box = [...document.querySelectorAll('.box_rounded')]
                .find(b => b.getBoundingClientRect().width > 0);

            if (!box) return;
            if (box.querySelector('.customize-icon')) return;

            box.style.position = 'relative';

            const icon = document.createElement('span');
            icon.className = 'customize-icon';
            icon.innerHTML =
                `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
            `;
            icon.addEventListener('click', () => {
                if (!panel) return;
                if (!pending) showPreview(saved);   // the page image may have loaded late
                panel.classList.add('is-open');
            });
            box.appendChild(icon);

        }

        // The observer only watches childList, so the class/data-mask attributes
        // applyMasks writes can't re-trigger it. Coalesced per frame because the
        // page re-renders these panels on every tab switch.
        let queued = false;
        function refresh() {
            queued = false;
            addIcon();
            applyMasks();
        }

        refresh();
        new MutationObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(refresh);
        }).observe(document.body, { childList: true, subtree: true });
    })();


})();
