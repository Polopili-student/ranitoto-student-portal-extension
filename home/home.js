(function () {
  'use strict';

  // tag the page to hide the original view 
  document.documentElement.classList.add('rangi-loading');
  function reveal() {
    document.documentElement.classList.remove('rangi-loading');
  }

  const url = chrome.runtime.getURL("DailyNotice/DailyNotice.html");

  function replaceLinks() {
    const links = document.querySelectorAll('a[href*="daily-notices"]');
    links.forEach(link => {
      if (link.href !== url) link.href = url;
    });
  }

  replaceLinks();

  const observer = new MutationObserver(replaceLinks);
  observer.observe(document.body, { childList: true, subtree: true });

  const INJECT_ID = '__rangi-menu-notifications';
  const TWOCOL_ID = '__rangi-two-col';

  // bell svg (from the original page)
  const BELL_SVG =
    '<svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" ' +
    'aria-hidden="true" class="inline-block size-5" height="1em" width="1em" ' +
    'xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" ' +
    'd="M5.25 9a6.75 6.75 0 0 1 13.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 0 1-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 1 1-7.48 0 24.585 24.585 0 0 1-4.831-1.244.75.75 0 0 1-.298-1.205A8.217 8.217 0 0 0 5.25 9.75V9Zm4.502 8.9a2.25 2.25 0 1 0 4.496 0 25.057 25.057 0 0 1-4.496 0Z" ' +
    'clip-rule="evenodd"></path></svg>';

  function findCardByTitle(title) {
    const strongs = document.querySelectorAll('header[data-slot="BoxHeader"] strong');
    for (const s of strongs) {
      if (s.textContent.trim() === title) {
        const header = s.closest('header[data-slot="BoxHeader"]');
        return header ? header.parentElement : null;
      }
    }
    return null;
  }

  // get the second column of the Menu
  function getMenuSecondColumn(menuCard) {
    const box = menuCard.querySelector('[data-slot="BoxContent"]');
    if (!box) return null;
    const cols = Array.from(box.children).filter((el) => el.tagName === 'DIV');
    return cols.length >= 2 ? cols[1] : null;
  }


  // put notification in Menu
  function mergeNotifications() {
    if (document.getElementById(INJECT_ID)) return true; // if element exist then skip

    const menuCard = findCardByTitle('Menu');
    const notiCard = findCardByTitle('Notifications');
    if (!menuCard || !notiCard) return false; // if both not exist 

    const targetCol = getMenuSecondColumn(menuCard);
    const notiList = notiCard.querySelector('[data-slot="BoxContent"]');
    if (!targetCol || !notiList) return false;

    const block = document.createElement('div');
    block.id = INJECT_ID;
    block.className = 'w-full px-2';

    const h3 = document.createElement('h3');
    h3.className =
      'text-md text-primary flex h-10 items-center gap-1 truncate border-b font-bold';
    h3.innerHTML = BELL_SVG + 'Notifications';

    block.appendChild(h3);
    block.appendChild(notiList);
    targetCol.appendChild(block);

    notiCard.style.setProperty('display', 'none', 'important');
    return true;
  }


  // rebuild the page into two column 
  function buildTwoColumn() {
    if (document.getElementById(TWOCOL_ID)) return true; // already changed 

    const menuCard = findCardByTitle('Menu');
    if (!menuCard) return false;

    const split = menuCard.parentElement;
    const mainWrap = split && split.parentElement;
    if (!split || !mainWrap) return false;

    // safety check, to check that both element exist
    if (!split.classList.contains('flex-col-reverse')) return false;
    if (!mainWrap.className.includes('max-w-7xl')) return false;

    // expand the page display area
    mainWrap.style.setProperty('max-width', 'min(95vw, 112rem)', 'important');

    // gathering the elements of right side 
    const rightItems = [];
    for (let n = split.nextElementSibling; n; n = n.nextElementSibling) {
      rightItems.push(n);
    }
    if (rightItems.length === 0) return false; // nothing there, skip

    const row = document.createElement('div');
    row.id = TWOCOL_ID;
    row.className = 'rangi-row flex flex-col gap-4 md:flex-row';

    const leftCol = document.createElement('div');   // menu col gap
    leftCol.className = 'rangi-left w-full min-w-0 flex flex-col gap-4';
    const rightCol = document.createElement('div');  // Dashboard col gap
    rightCol.className = 'rangi-right w-full min-w-0 flex flex-col gap-4';

    leftCol.appendChild(menuCard);                     // move menu to left 
    rightItems.forEach((n) => rightCol.appendChild(n)); // move others to right 

    row.appendChild(leftCol);
    row.appendChild(rightCol);
    mainWrap.insertBefore(row, split);

    split.style.setProperty('display', 'none', 'important');
    return true;
  }

  // the original menu if 2 col, change to one 
  function tidyMenu() {
    const menuCard = findCardByTitle('Menu');
    if (!menuCard) return false;
    if (menuCard.dataset.rangiTidy) return true; // wait for prev func to finish 

    const box = menuCard.querySelector('[data-slot="BoxContent"]');
    if (!box) return false;

    // find the three section by h3
    const sectionByTitle = (kw) => {
      const h3 = Array.from(box.querySelectorAll('h3')).find((h) =>
        h.textContent.trim().startsWith(kw)
      );
      return h3 ? h3.parentElement : null;
    };
    const secPages = sectionByTitle('My Pages');
    const secNoti = sectionByTitle('Notifications');
    const secQuick = sectionByTitle('Quicklinks');
    if (!secPages || !secNoti || !secQuick) return false; // if not ready, skip 


    menuCard.querySelectorAll('ul').forEach((ul) => {
      ul.classList.remove('lg:columns-2', 'columns-2');
    });

    const oldCols = Array.from(box.children).filter((el) => el.tagName === 'DIV');

    box.style.setProperty('flex-direction', 'column');
    [secPages, secNoti, secQuick].forEach((s) => box.appendChild(s));

    oldCols.forEach((c) => c.style.setProperty('display', 'none', 'important'));

    menuCard.dataset.rangiTidy = '1';
    return true;
  }

  // place 'My Dashboard' n the center of dashboard page 
  function embedDashboardTitle() {
    const TITLE_ID = '__rangi-dashboard-title';
    if (document.getElementById(TITLE_ID)) return true; // already done

    // My Dashboard 
    let h2 = null;
    document.querySelectorAll('h2').forEach((el) => {
      if (el.textContent.trim() === 'My Dashboard') h2 = el;
    });
    let redHeader = null;
    document.querySelectorAll('header[data-slot="BoxHeader"]').forEach((h) => {
      if (h.className.includes('fsm-red')) redHeader = h;
    });
    if (!h2 || !redHeader) return false;

    redHeader.style.setProperty('position', 'relative');

    const span = document.createElement('span');
    span.id = TITLE_ID;
    span.textContent = 'My Dashboard';
    span.className = 'text-lg font-bold whitespace-nowrap';
    redHeader.insertBefore(span, redHeader.firstChild);

    h2.style.setProperty('display', 'none', 'important');
    return true;
  }

  // place the school report
  function embedSchoolReport() {
    const REPORT_ID = '__rangi-school-report';
    if (document.getElementById(REPORT_ID)) return true; // already done
    const menuCard = findCardByTitle('Menu');
    if (!menuCard) return false;

    const box = menuCard.querySelector('[data-slot="BoxContent"]');
    if (!box) return false;

    // find the three section by h3
    const sectionByTitle = (kw) => {
      const h3 = Array.from(box.querySelectorAll('h3')).find((h) =>
        h.textContent.trim().startsWith(kw)
      );
      return h3 ? h3.parentElement : null;
    };
    const secPages = sectionByTitle('My Pages');
    const secNoti = sectionByTitle('Notifications');
    const secQuick = sectionByTitle('Quicklinks');
    if (!secPages || !secNoti || !secQuick) return false; // if not ready, skip 

    const reportDiv = document.createElement('li');
    reportDiv.id = REPORT_ID;

    reportDiv.innerHTML = 
    `
    <a class="hover:bg-prime dark:text-foreground flex min-h-8 gap-1.5 border-b border-dashed py-2 pr-2 pl-2 text-sm font-medium text-pretty text-(--fsm-space-blue) lg:pr-4 pointer-coarse:py-3"
      href="https://spider.rangitoto.school.nz/Pages/ReportView.aspx?arg=%27QUICKPRINT%27&type=undefined&m=undefined&wa=">
    School Report
    </a>
    `;
    secPages.querySelector('ul').appendChild(reportDiv);
    return true;
  }


  const RETRY_INTERVAL = 200;
  const MAX_RETRY = 25;

  (function attempt(count) {
    const doneA = mergeNotifications();
    const doneB = buildTwoColumn();
    const doneC = tidyMenu();
    const doneD = embedSchoolReport();
    const doneE = embedDashboardTitle();
    if (doneA && doneB && doneC && doneD && doneE) { reveal(); return; }
    if (count < MAX_RETRY) {
      setTimeout(() => attempt(count + 1), RETRY_INTERVAL);
    } else {
      reveal();
    }
  })(0);
})();
