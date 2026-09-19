/* Renders the theatre board and drives the emergency recalculation. */
const PRIORITY_ORDER = { emergency: 0, urgent: 1, elective: 2 };
let DAY = { start: 480, end: 1200 };
let emergencyAlarmInterval = "patient name";
let emergencyAudioContext = null;

const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const pct = (m) => ((m - DAY.start) / (DAY.end - DAY.start)) * 100;
const el = (tag, cls) => { const node = document.createElement(tag); if (cls) node.className = cls; return node; };
const nonBlank = (value) => value !== undefined && value !== null && String(value).trim() !== "";
const firstValue = (...values) => values.find(nonBlank) ?? "";
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[char]));

function requestAlertPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}


function startEmergencyAlarm(kind = "ok") {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  if (!emergencyAudioContext) {
    emergencyAudioContext = new AudioContextClass();
  }

  const ctx = emergencyAudioContext;
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const tone = (frequency, start, duration, type = "triangle") => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime + start);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + duration);
  };

  const playPattern = () => {
    const frequencies = kind === "fail" ? [600, 450, 320] : [820, 680, 560];
    frequencies.forEach((frequency, index) => {
      tone(frequency, index * 0.18, 0.22, kind === "fail" ? "sawtooth" : "triangle");
    });
  };

  stopEmergencyAlarm();
  playPattern();
  emergencyAlarmInterval = setInterval(playPattern, 1800);
}

function stopEmergencyAlarm() {
  if (emergencyAlarmInterval) {
    clearInterval(emergencyAlarmInterval);
    emergencyAlarmInterval = "patient name";
  }

  if (emergencyAudioContext && emergencyAudioContext.state !== "closed") {
    emergencyAudioContext.close().catch(() => {});
    emergencyAudioContext = null;
  }
}

async function loadSchedule() {
  const res = await fetch("/api/schedule");
  render(await res.json());
}

async function loadAiSummary() {
  const box = document.getElementById("ai-summary");
  const score = document.getElementById("ai-score");
  if (!box || !score) return;

  try {
    const res = await fetch("/api/ai-summary");
    const data = await res.json();
    box.innerHTML = `<ul>${data.recommendations.map((item) => `<li>${item}</li>`).join("")}</ul>`;
    score.textContent = `${data.score}/100`;
    score.dataset.level = data.score >= 75 ? "good" : data.score >= 55 ? "watch" : "alert";
  } catch (err) {
    box.innerHTML = "<ul><li>AI review unavailable right now.</li></ul>";
    score.textContent = "--";
  }
}

async function fillAiIntake(formId, defaults = {}) {
  const form = document.getElementById(formId);
  if (!form) return;

  const btn = form.querySelector("#ai-fill-request") || form.querySelector("#ai-fill-emergency");
  const oldText = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "AI Selecting...";
  }

  const payload = {
    patient: form.patient?.value?.trim() || defaults.patient || "",
    procedure: form.procedure?.value?.trim() || defaults.procedure || "",
    surgeon_id: form.surgeon_id?.value || defaults.surgeon_id || "",
    ot_type: form.ot_type?.value || defaults.ot_type || "",
    priority: form.priority?.value || defaults.priority || "",
    duration: form.duration?.value || defaults.duration || "",
  };

  try {
    const res = await fetch("/api/ai-intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error("AI endpoint returned non-200");
    const data = await res.json();

    if (form.patient && (!form.patient.value || form.patient.value === "New patient")) {
      form.patient.value = data.patient;
    }
    if (form.procedure) form.procedure.value = data.procedure;
    if (form.duration) form.duration.value = data.duration;
    if (form.surgeon_id && data.surgeon_id) form.surgeon_id.value = data.surgeon_id;
    if (form.ot_type && data.ot_type) form.ot_type.value = data.ot_type;
    if (form.priority && data.priority) form.priority.value = data.priority;
    if (form.arrives_at) form.arrives_at.value = form.arrives_at.value || "11:20";

    form.querySelectorAll("input[name=equipment]").forEach((box) => {
      const matched = (data.equipment || []).includes(box.value);
      box.checked = matched;
      box.closest("label")?.classList.toggle("equipment-ai-selected", matched);
    });

    showNotification(data.alert_message || "AI auto-fill completed.", "ok");
  } catch (err) {
    console.error("AI Intake error:", err);
    showNotification("AI intake could not populate the form right now.", "fail");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || "AI auto-fill";
    }
  }
}

function refreshDashboard() {
  if (document.getElementById("board-inner")) {
    loadSchedule();
    loadAiSummary();
  }
}

function render(data, moved = []) {
  DAY = { start: data.day_start, end: data.day_end };
  drawBoard(data, Array.isArray(moved) ? moved : []);
  drawStats(data.metrics);
  drawLiveDetails(data);
  drawWaitlist(data.waitlist);
  drawLog(data.log);

  const status = document.getElementById("live-status");
  if (status) {
    status.textContent = `Last updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
}

function drawLiveDetails(data) {
  const box = document.getElementById("live-details");
  if (!box) return;

  const theatreTypes = [...new Set(data.theatres.map((theatre) => theatre.ot_type))];
  const urgentCases = data.theatres
    .flatMap((theatre) => theatre.cases)
    .filter((item) => item.priority === "urgent" || item.priority === "emergency").length;

  box.innerHTML = `
    <div class="live-grid">
      <div class="live-card"><span class="live-num">${data.theatres.length}</span><small>active theatres</small></div>
      <div class="live-card"><span class="live-num">${urgentCases}</span><small>urgent cases</small></div>
      <div class="live-card"><span class="live-num">${theatreTypes.length}</span><small>specialties</small></div>
      <div class="live-card"><span class="live-num">${data.waitlist.length}</span><small>waitlisted</small></div>
    </div>
    <div class="live-list"><strong>Specialty mix:</strong> ${theatreTypes.map((type) => type.toUpperCase()).join(" · ") || "General"}</div>
  `;
}

function drawBoard(data, moved) {
  const inner = document.getElementById("board-inner");
  if (!inner) return;
  inner.innerHTML = "";

  const hours = [];
  for (let hour = Math.ceil(DAY.start / 60); hour <= Math.floor(DAY.end / 60); hour++) {
    hours.push(hour * 60);
  }

  const ruler = el("div", "ruler");
  hours.forEach((minute) => {
    const span = el("span");
    span.textContent = clock(minute);
    ruler.appendChild(span);
  });
  inner.appendChild(ruler);

  data.theatres.forEach((ot) => {
    const lane = el("div", "lane");
    const rail = el("div", "lane-rail");
    const utilisation = data.metrics.utilisation[ot.id] ?? 0;
    rail.innerHTML = `<div class="name">${ot.name}</div>
      <div class="meta">${ot.ot_type} · ${ot.cases.length} case${ot.cases.length === 1 ? "" : "s"} · ${utilisation}%</div>
      <div class="util"><i style="width:${utilisation}%"></i></div>`;
    lane.appendChild(rail);

    const track = el("div", "lane-track");
    hours.forEach((minute) => {
      const tick = el("div", "tick");
      tick.style.left = `${pct(minute)}%`;
      track.appendChild(tick);
    });

    ot.cases.forEach((item) => {
      const box = el("div", `case${moved.includes(item.id) ? " moved" : ""}`);
      box.dataset.priority = item.priority;
      box.style.left = `${pct(item.start)}%`;
      box.style.width = `${((item.end - item.start) / (DAY.end - DAY.start)) * 100}%`;
      box.title = `${item.procedure} — ${item.patient}\n${item.start_label}–${item.end_label} · ${item.surgeon}${item.equipment.length ? `\nEquipment: ${item.equipment.join(", ")}` : ""}`;
      box.innerHTML = `<div class="proc">${item.procedure}</div>
        <div class="who">${item.patient} · ${item.surgeon}</div>
        <div class="time">${item.start_label}–${item.end_label}</div>`;
      track.appendChild(box);
    });

    lane.appendChild(track);
    inner.appendChild(lane);
  });

  drawNowLine(inner);
}

function drawNowLine(inner) {
  if (!inner) return;
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (minute < DAY.start || minute > DAY.end) return;

  const line = el("div", "now-line");
  line.dataset.label = `now ${clock(minute)}`;
  const railWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--rail-w"), 10);
  line.style.left = `calc(${railWidth}px + (100% - ${railWidth}px) * ${pct(minute) / 100})`;
  inner.appendChild(line);
}

function drawStats(metrics) {
  const statsEl = document.getElementById("stats");
  if (!statsEl) return;

  const load = Object.values(metrics.surgeon_load)
    .map((surgeon) => `<tr><td>${surgeon.name}</td><td>${surgeon.used} / ${surgeon.cap} min</td></tr>`)
    .join("");

  statsEl.innerHTML = `
    <div class="stat"><div class="n">${metrics.scheduled}</div><div class="k">cases scheduled</div></div>
    <div class="stat"><div class="n">${metrics.waitlisted}</div><div class="k">on the waitlist</div></div>
    <div class="stat"><div class="n">${metrics.avg_wait}</div><div class="k">avg wait, minutes</div></div>`;

  const surgeonLoad = document.getElementById("surgeon-load");
  if (surgeonLoad) surgeonLoad.innerHTML = load;
}

function drawWaitlist(items) {
  const box = document.getElementById("waitlist");
  if (!items.length) {
    box.innerHTML = '<p class="empty">Every request found a slot today.</p>';
    return;
  }

  box.innerHTML = items.map((item) => `
    <div style="margin-bottom:.75rem">
      <span class="tag" data-priority="${item.priority}">${item.priority}</span>
      <strong>${item.procedure}</strong> — ${item.patient}
      <div class="reason">${item.reasons.slice(0, 3).join(" · ")}</div>
    </div>`).join("");
}

function drawLog(lines) {
  const logEl = document.getElementById("log");
  if (!logEl) return;
  logEl.innerHTML = lines.slice(-14).reverse().map((line) => `<li>${line}</li>`).join("");
}

function readField(record, names) {
  if (!record || typeof record !== "object") return "";
  for (const name of names) {
    const value = record[name];
    if (Array.isArray(value) && value.length) return value.filter(nonBlank).join(", ");
    if (nonBlank(value)) return value;
  }
  return "";
}

function selectedLabel(form, name, fallback = "") {
  const input = form?.elements?.namedItem(name);
  return input?.selectedOptions?.[0]?.textContent?.trim() || fallback;
}

function formatTime(value) {
  const minutes = Number(value);
  return nonBlank(value) && Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440
    ? clock(minutes)
    : nonBlank(value)
      ? String(value)
      : "Not scheduled";
}

function formatDuration(value) {
  const minutes = Number(value);
  return nonBlank(value) && Number.isFinite(minutes) && minutes > 0
    ? `${minutes} minutes`
    : nonBlank(value)
      ? String(value)
      : "Not provided";
}

function getEmergencyRecord(data, submitted) {
  const delta = data?.delta || {};
  const candidates = [
    data?.emergency,
    data?.emergency_case,
    data?.placed_case,
    data?.case,
    delta.emergency,
    delta.emergency_case,
    delta.placed_case,
    delta.case,
  ].filter(Boolean);

  const cases = (data?.theatres || []).flatMap((theatre) => theatre.cases || []);
  const expectedId = firstValue(
    readField(delta, ["case_id", "placed_case_id", "emergency_id"]),
    readField(data, ["case_id", "placed_case_id", "emergency_id"])
  );

  const scheduled = cases.find((item) => String(item.id) === String(expectedId))
    || cases.find((item) => item.priority === "emergency" && (item.patient === submitted.patient || item.procedure === submitted.procedure))
    || cases.find((item) => item.priority === "emergency");

  return { record: candidates[0] || scheduled || {}, scheduled };
}

function movedCaseNames(data, moved) {
  const cases = (data?.theatres || []).flatMap((theatre) => theatre.cases || []);
  return moved.map((item) => {
    if (item && typeof item === "object") {
      return firstValue(readField(item, ["procedure", "name", "patient"]), "Scheduled case");
    }

    const match = cases.find((entry) => String(entry.id) === String(item));
    return match ? `${match.procedure} (${match.patient})` : "Scheduled case";
  });
}

function emergencyResult(data, submitted, form) {
  const delta = data?.delta || {};
  const { record, scheduled } = getEmergencyRecord(data, submitted);
  const moved = Array.isArray(delta.moved) ? delta.moved : [];
  const disruption = Number.isFinite(Number(delta.disruption)) ? Number(delta.disruption) : moved.length;
  const placedFlag = [true, "true", "yes", "placed"].includes(delta.placed)
    || [true, "true", "yes", "placed"].includes(data?.placed);
  const placed = placedFlag || Boolean(scheduled && nonBlank(scheduled.start));

  const room = firstValue(
    readField(record, ["theatre_name", "room_name", "room", "ot_name", "theatre"]),
    readField(scheduled, ["theatre_name", "room_name", "room", "ot_name", "theatre"]),
    selectedLabel(form, "ot_type", submitted.ot_type)
  );
  const surgeon = firstValue(
    readField(record, ["surgeon", "surgeon_name", "doctor", "doctor_name"]),
    readField(data, ["surgeon", "surgeon_name", "doctor", "doctor_name"]),
    selectedLabel(form, "surgeon_id", submitted.surgeon_id),
    "Not provided"
  );
  const condition = firstValue(
    readField(record, ["disease", "condition", "diagnosis", "indication"]),
    readField(data, ["disease", "condition", "diagnosis", "indication"]),
    "Not provided"
  );
  const specialty = firstValue(
    readField(record, ["related_doctor", "specialty", "speciality", "department"]),
    readField(data, ["related_doctor", "specialty", "speciality", "department"]),
    "Not provided"
  );
  const procedure = firstValue(readField(record, ["procedure", "surgery", "procedure_name"]), submitted.procedure, "Emergency procedure");
  const equipment = firstValue(readField(record, ["equipment", "required_equipment"]), submitted.equipment?.join(", "));
  const arrival = formatTime(firstValue(readField(record, ["arrives_at", "arrival_time", "arrival"]), submitted.arrives_at));
  const start = formatTime(firstValue(readField(record, ["start_label", "start_time", "start"]), readField(scheduled, ["start_label", "start_time", "start"])));
  const end = formatTime(firstValue(readField(record, ["end_label", "end_time", "end"]), readField(scheduled, ["end_label", "end_time", "end"])));
  const movedNames = movedCaseNames(data, moved);
  const change = disruption > 0
    ? `${disruption} scheduled case${disruption === 1 ? " was" : "s were"} moved${movedNames.length ? `: ${movedNames.join(", ")}` : ""}.`
    : "The emergency was placed in an available slot; no scheduled cases were moved.";

  const patientName = firstValue(readField(record, ["patient", "patient_name"]), submitted.patient, "Unidentified patient");
  const summaryBase = `Emergency alert: Patient: ${patientName} | Doctor: ${surgeon} | Diagnosis: ${condition} | Procedure: ${procedure} | OT timing: ${arrival} | Duration: ${formatDuration(firstValue(readField(record, ["duration", "duration_minutes"]), submitted.duration))}`;

  const row = (label, value) => `<div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`;
  const rows = [
    row("Patient", patientName),
    row("Doctor / surgeon", surgeon),
    row("Condition / disease", condition),
    row("Related specialty / doctor", specialty),
    row("Surgery / procedure", procedure),
    row("Duration", formatDuration(firstValue(readField(record, ["duration", "duration_minutes"]), submitted.duration))),
    row("OT / room", room || "Not provided"),
    equipment ? row("Equipment", equipment) : "",
    row("Priority", firstValue(readField(record, ["priority"]), "Emergency")),
    row("Timing", `Arrival ${arrival} · Scheduled ${start}–${end}`),
    row("Recalculation", change),
  ].filter(Boolean).join("");

  return {
    placed,
    summary: placed
      ? `${summaryBase}. ${change}`
      : `${summaryBase}. No safe slot was available; escalate to another facility immediately.`,
    html: `<div class="emergency-result"><strong>${placed ? "Emergency schedule updated" : "Emergency could not be scheduled"}</strong><div class="emergency-details">${rows}</div></div>`,
  };
}

async function raiseEmergency(event) {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Recalculating…";

  const body = {
    patient: form.patient.value || "Unidentified patient",
    procedure: form.procedure.value,
    duration: Number(form.duration.value),
    surgeon_id: form.surgeon_id.value,
    ot_type: form.ot_type.value,
    arrives_at: form.arrives_at.value,
    equipment: [...form.querySelectorAll("input[name=equipment]:checked")].map((item) => item.value),
  };

  try {
    const res = await fetch("/api/emergency", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("The server returned an unreadable emergency recalculation response.");
    }

    if (!res.ok) {
      throw new Error(firstValue(readField(data, ["error", "message", "detail"]), `Emergency recalculation failed (server error ${res.status}).`));
    }

    if (!data || !Array.isArray(data.theatres)) {
      throw new Error(firstValue(readField(data, ["error", "message"]), "Emergency recalculation completed without a valid updated schedule."));
    }

    render(data, data.delta?.moved);
    const result = emergencyResult(data, body, form);
    showNotification(result.html, result.placed ? "ok" : "fail", {
      allowHtml: true,
      plainMessage: result.summary,
      title: result.placed ? "Emergency recalculation complete" : "Emergency scheduling alert",
      timeout: 20000,
      forceBrowserAlert: true,
    });

    loadAiSummary();
    if (result.placed) form.reset();
  } catch (err) {
    showNotification(nonBlank(err?.message) ? err.message : "The emergency recalculation did not complete.", "fail", {
      title: "Emergency recalculation failed",
    });
  } finally {
    button.disabled = false;
    button.textContent = "Add emergency and recalculate";
  }
}

function showNotification(message, kind = "ok", options = {}) {
  const content = typeof message === "string" ? message.trim() : "";
  if (!content) {
    console.warn("Notification skipped because no message was supplied.");
    return false;
  }

  const plainMessage = firstValue(
    options.plainMessage,
    content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")
  );
  const notificationHtml = options.allowHtml ? content : escapeHtml(content).replace(/\n/g, "<br>");
  const shouldForceAlert = Boolean(options.forceBrowserAlert || kind === "fail");

  requestAlertPermission();
  showDesktopAlert(plainMessage, kind);
  startEmergencyAlarm(kind);

  if (shouldForceAlert && typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(plainMessage);
  }

  const box = document.getElementById("notice");
  if (!box) {
    return true;
  }

  const title = options.title || (kind === "fail" ? "Emergency alert" : "AI Assistant Update");
  box.hidden = false;
  box.dataset.kind = kind;
  box.innerHTML = `<div class="notice-row"><div><strong>${escapeHtml(title)}</strong><br>${notificationHtml}</div><button type="button" class="notice-close" aria-label="Dismiss alert">Dismiss</button></div>`;
  box.classList.add("show");
  box.setAttribute("role", "alert");

  box.querySelector(".notice-close")?.addEventListener("click", () => {
    box.classList.remove("show");
    box.hidden = true;
    stopEmergencyAlarm();
  });

  clearTimeout(box.toastTimer);
  box.toastTimer = setTimeout(() => {
    box.classList.remove("show");
    box.hidden = true;
    stopEmergencyAlarm();
  }, options.timeout || 10000);

  return true;
}

function triggerEmergencyAlert() {
  const patient = document.getElementById("e-patient")?.value?.trim() || "Unidentified patient";
  const procedure = document.getElementById("e-procedure")?.value?.trim() || "Emergency procedure";
  const diagnosis = document.getElementById("e-diagnosis")?.value?.trim() || procedure;
  const surgeonSelect = document.getElementById("e-surgeon");
  const surgeonName = surgeonSelect?.selectedOptions?.[0]?.textContent?.split(" — ")[0] || "On-call surgeon";
  const otTime = document.getElementById("e-arrives")?.value || "11:20";
  const durationMinutes = document.getElementById("e-duration")?.value || 90;

  const message = buildEmergencyAlertMessage(patient, surgeonName, diagnosis, procedure, otTime, durationMinutes);
  requestAlertPermission();
  showNotification(message, "fail");

  const form = document.getElementById("emergency-form");
  if (form) form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildEmergencyAlertMessage(patient, surgeonName, diagnosis, procedure, otTime, durationMinutes) {
  const patientName = patient || "Unidentified patient";
  const doctorName = surgeonName || "On-call surgeon";
  const diagnosisText = diagnosis || procedure || "Emergency condition";
  const procedureText = procedure || "Emergency procedure";
  const theatreTime = otTime || "11:20";
  const durationText = Number(durationMinutes) > 0 ? Number(durationMinutes) : 90;

  return `Emergency alert: Patient: ${patientName} | Doctor: ${doctorName} | Diagnosis: ${diagnosisText} | Procedure: ${procedureText} | OT timing: ${theatreTime} | Duration: ${durationText} min`;
}

function setupCheckboxSync() {
  document.querySelectorAll("input[name=equipment]").forEach((box) => {
    box.addEventListener("change", () => {
      const label = box.closest("label");
      if (label) {
        label.classList.toggle("equipment-ai-selected", box.checked);
      }
    });
  });
}

function setupLiveProcedureEquipmentMatcher() {
  const input = document.getElementById("procedure") || document.getElementById("e-procedure");
  if (!input) return;

  let timer = null;
  input.addEventListener("input", (event) => {
    const text = event.target.value.trim();
    if (text.length < 3) return;

    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const form = input.closest("form");
        const res = await fetch("/api/ai-intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            procedure: text,
            ot_type: form?.ot_type?.value || "any",
            patient: form?.patient?.value || "",
          }),
        });

        if (!res.ok) return;
        const data = await res.json();
        if (!form) return;

        if (data.ot_type && form.ot_type && (form.ot_type.value === "any" || !form.ot_type.value)) {
          form.ot_type.value = data.ot_type;
        }
        if (data.surgeon_id && form.surgeon_id) form.surgeon_id.value = data.surgeon_id;
        if (data.duration && form.duration) form.duration.value = data.duration;
        if (data.priority && form.priority) form.priority.value = data.priority;

        form.querySelectorAll("input[name=equipment]").forEach((box) => {
          const matched = (data.equipment || []).includes(box.value);
          box.checked = matched;
          box.closest("label")?.classList.toggle("equipment-ai-selected", matched);
        });
      } catch (err) {}
    }, 450);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  refreshDashboard();
  if (document.getElementById("board-inner")) {
    setInterval(refreshDashboard, 12000);
  }

  const requestButton = document.getElementById("ai-fill-request");
  if (requestButton) {
    requestButton.addEventListener("click", () => fillAiIntake("request-form"));
  }

  const emergencyButton = document.getElementById("ai-fill-emergency");
  if (emergencyButton) {
    emergencyButton.addEventListener("click", () => fillAiIntake("emergency-form"));
  }

  const quickEmergencyButton = document.getElementById("quick-emergency-alert");
  if (quickEmergencyButton) {
    quickEmergencyButton.addEventListener("click", triggerEmergencyAlert);
  }

  setupCheckboxSync();
  setupLiveProcedureEquipmentMatcher();
  requestAlertPermission();

  const form = document.getElementById("emergency-form");
  if (form) form.addEventListener("submit", raiseEmergency);
});
