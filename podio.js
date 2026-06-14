// WorkHub - Netlify Function - Podio Direct API
// Uses Podio OAuth client credentials flow

const PODIO_CLIENT_ID = process.env.PODIO_CLIENT_ID;
const PODIO_CLIENT_SECRET = process.env.PODIO_CLIENT_SECRET;

const PODIO_CONFIG = {
  mcl: {
    orgId: "443566",
    workspaceId: "2855687",
    employeesAppId: "13783919",
    pinFieldId: "277090564",
    workOrdersAppId: "21648006",
    scheduleAppId: "28872040",
    workingTimeReportAppId: "17154684",
  },
  ptl: {
    orgId: "443566",
    workspaceId: "2506909",
    employeesAppId: "12869026",
    pinFieldId: "277090566",
    workOrdersAppId: "21650745",
    scheduleAppId: "28872291",
    workingTimeReportAppId: "29056094",
  },
};

let cachedToken = null;
let tokenExpiry = 0;

async function getPodioToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch("https://podio.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: PODIO_CLIENT_ID,
      client_secret: PODIO_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Podio auth failed: " + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function podioGet(path) {
  const token = await getPodioToken();
  const res = await fetch("https://api.podio.com" + path, {
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  return res.json();
}

async function podioPost(path, body) {
  const token = await getPodioToken();
  const res = await fetch("https://api.podio.com" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function podioPut(path, body) {
  const token = await getPodioToken();
  const res = await fetch("https://api.podio.com" + path, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const { action, company, pin, workOrderItemId, employeePodioId, wtrItemId, startTime, endTime } = JSON.parse(event.body);
    const cfg = PODIO_CONFIG[company];
    if (!cfg) return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid company" }) };

    // ── FIND EMPLOYEE BY PIN ────────────────────────────────────────────────
    if (action === "findEmployee") {
      const data = await podioPost("/item/app/" + cfg.employeesAppId + "/filter/", {
        filters: { [cfg.pinFieldId]: pin },
        limit: 1,
      });
      if (data.items && data.items.length > 0) {
        const item = data.items[0];
        const name = item.title || "Employee";
        return { statusCode: 200, headers, body: JSON.stringify({ itemId: String(item.item_id), name }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ error: "PIN not found" }) };
    }

    // ── GET TODAY'S SCHEDULE ────────────────────────────────────────────────
    else if (action === "getSchedule") {
      const today = new Date().toISOString().split("T")[0];
      const data = await podioPost("/item/app/" + cfg.scheduleAppId + "/filter/", {
        filters: {},
        limit: 20,
        sort_by: "created_on",
        sort_desc: false,
      });

      const schedule = [];
      if (data.items) {
        for (const item of data.items) {
          // Find employee relationship field and check if this employee is in it
          let hasEmployee = false;
          let workOrderId = null;
          let workOrderTitle = null;
          let dateVal = null;
          let timeVal = null;

          for (const field of (item.fields || [])) {
            if (field.type === "app" && field.label && field.label.toLowerCase().includes("employee")) {
              const vals = field.values || [];
              hasEmployee = vals.some(v => v.value && String(v.value.item_id) === String(employeePodioId));
            }
            if (field.type === "app" && field.label && (field.label.toLowerCase().includes("work order") || field.label.toLowerCase().includes("workorder"))) {
              const vals = field.values || [];
              if (vals.length > 0 && vals[0].value) {
                workOrderId = String(vals[0].value.item_id);
                workOrderTitle = vals[0].value.title;
              }
            }
            if (field.type === "date") {
              const vals = field.values || [];
              if (vals.length > 0) {
                dateVal = vals[0].start_date || vals[0].start || null;
                timeVal = vals[0].start_time || null;
              }
            }
          }

          // Only include items for today and this employee
          if (hasEmployee && (!dateVal || dateVal.startsWith(today))) {
            schedule.push({
              itemId: String(item.item_id),
              title: item.title,
              workOrderId,
              workOrderTitle: workOrderTitle || item.title,
              date: dateVal || today,
              time: timeVal,
            });
          }
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ schedule }) };
    }

    // ── CLOCK IN ───────────────────────────────────────────────────────────
    else if (action === "clockIn") {
      // 1. Update Work Order - add employee to Clock In field
      if (workOrderItemId) {
        const woData = await podioGet("/item/" + workOrderItemId);
        const clockInField = (woData.fields || []).find(f =>
          f.label && f.label.toLowerCase().includes("clock in")
        );
        if (clockInField) {
          const existing = (clockInField.values || []).map(v => ({ value: v.value.item_id }));
          existing.push({ value: parseInt(employeePodioId) });
          await podioPut("/item/" + workOrderItemId + "/value/" + clockInField.field_id, existing);
        }
      }

      // 2. Create Working Time Report
      const now = new Date();
      const wtr = await podioPost("/item/app/" + cfg.workingTimeReportAppId + "/", {
        fields: {
          "employee": [{ value: parseInt(employeePodioId) }],
          "start-time": startTime,
          "category": "Work",
          "category-2": "Fresh",
        },
        silent: true,
        hook: false,
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, wtrItemId: String(wtr.item_id || "") }) };
    }

    // ── CLOCK OUT ──────────────────────────────────────────────────────────
    else if (action === "clockOut") {
      // 1. Update Work Order - add employee to Clock Out field
      if (workOrderItemId) {
        const woData = await podioGet("/item/" + workOrderItemId);
        const clockOutField = (woData.fields || []).find(f =>
          f.label && f.label.toLowerCase().includes("clock out")
        );
        if (clockOutField) {
          const existing = (clockOutField.values || []).map(v => ({ value: v.value.item_id }));
          existing.push({ value: parseInt(employeePodioId) });
          await podioPut("/item/" + workOrderItemId + "/value/" + clockOutField.field_id, existing);
        }
      }

      // 2. Update Working Time Report with end time
      if (wtrItemId) {
        await podioPut("/item/" + wtrItemId + "/value/end-time", endTime);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action" }) };

  } catch (err) {
    console.error("WorkHub function error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
