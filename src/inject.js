console.log("inject.js worked");
const attendancePath = "/api/home/MyStudentsAttendance";
const calendarPath = "/Handlers/Calendar.asmx/GetCalendarTypes";
const calendarEventsPath = "/Handlers/Calendar.asmx/GetCalendar";
const calendarShowPath = "/Handlers/Calendar.asmx/GetDayCalendar"

// define rules to change a request
const rules = {
    [attendancePath]: function (data) {
        for (const day of Object.values(data.RollDays)) {
            const periods = day.Periods;
            if (periods["6"]) {
                delete periods["6"];
                if (periods["3"]) {
                    periods["3"].PeriodName = "Pd 3";
                }
            }
        }
        console.log("result:", data.RollDays.DAY0.Periods);
        return data;
    }, 
    [calendarPath]: function (data) {
        const colorRules = {
            "Holidays / Non-contact days": "8B6DB8",  // #8B6DB8
            "Assessments":                 "D0483A",  // #D0483A
            "Exams":                       "A83328",  // #A83328
            "Test":                        "EB8B33",  // #EB8B33
            "General":                     "6B7C8E",  // #6B7C8E
            "Daily Messages":              "3492CE",  // #3492CE
            "Homework":                    "D97D2A",  // #D97D2A
            "Student lunchtime events":    "48A862",  // #48A862
            "Trips":                       "2C7FB5",  // #2C7FB5
        };
        for (const types of Object.values(data.d)) {
                if (Object.hasOwn(colorRules, types.Name)) {
                    types.Color = colorRules[types.Name];
                    console.log(`type: ${types.Name}`);
                    console.log(`edited: ${types.Color}`);
                }
        }
        console.log("result:", data.d.Name)
        return data;
    }, 
    [calendarEventsPath]: function (data) {
        if (data.d && data.d.Types && data.d.Types["HD"]) {
            data.d.Types["HD"].Color = "7A4BA8";   // Holiday 紫
        }
        return data;
    }, 
    [calendarShowPath]: function (data) {
        const colorRules = {
            "Holiday": "8B6DB8",  // #8B6DB8
            "Assessments":                 "D0483A",  // #D0483A
            "Exams":                       "A83328",  // #A83328
            "Test":                        "EB8B33",  // #EB8B33
            "General":                     "6B7C8E",  // #6B7C8E
            "Daily Messages":              "3492CE",  // #3492CE
            "Homework":                    "D97D2A",  // #D97D2A
            "Student lunchtime events":    "48A862",  // #48A862
            "Trips":                       "2C7FB5",  // #2C7FB5
        };
        for (const type of Object.values(data.d.Types)) {
            if (Object.hasOwn(colorRules, type.Name)) {
                type.Color = colorRules[type.Name];
            }
        }
        return data; 
    }

};

// a general function to apply the change. 
function applyRules(url, body) {
    const matched = Object.keys(rules).find(path => url && url.includes(path));
    if (!matched) {
        console.log("Match failed: ", url);
        return null;
    }
    console.log("Matched: ", matched);
    try {
        const data = JSON.parse(body);
        const modified = rules[matched](data);
        return JSON.stringify(modified);
    } catch (e) {
        console.error("Rewrite Failed:", e);
        return null;
    }
}

// ===== when request is fetch =====
const originalFetch = window.fetch;
window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const response = await originalFetch(...args);
    if (!url) return response;

    const body = await response.clone().text();
    const modified = applyRules(url, body);
    if (modified === null) return response;

    return new Response(modified, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
};

// ===== when request is xml =====
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;   // save url 
    return origOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("readystatechange", function () {
        if (this.readyState === 4) {   // 4 = request complete
            const modified = applyRules(this._url, this.responseText);
            if (modified !== null) {
                // responseText / response is read only,so use defineProperty to rewrite
                Object.defineProperty(this, "responseText", { get: () => modified });
                Object.defineProperty(this, "response", { get: () => modified });
            }
        }
    }, false);
    return origSend.apply(this, args);
};