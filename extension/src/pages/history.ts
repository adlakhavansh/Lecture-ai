import type { HistoryEntry } from "../types";

const listEl = document.getElementById("list")!;
const emptyEl = document.getElementById("empty")!;
const countEl = document.getElementById("count")!;
const qEl = document.getElementById("q") as HTMLInputElement;

let entries: HistoryEntry[] = [];

function esc(text: string): string {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Today" and "Yesterday" carry more meaning than a date for recent lectures,
 *  which is most of what this list holds. */
function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function duration(entry: HistoryEntry): string {
  const mins = Math.max(1, Math.round((entry.endTime - entry.startTime) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function matches(entry: HistoryEntry, q: string): boolean {
  if (!q) return true;
  const hay = [entry.title, entry.tabUrl, ...(entry.topics || [])].join(" ").toLowerCase();
  return hay.includes(q);
}

function render() {
  const q = qEl.value.trim().toLowerCase();
  const shown = entries.filter((e) => matches(e, q));

  countEl.textContent = shown.length
    ? `${shown.length} lecture${shown.length === 1 ? "" : "s"}`
    : "";

  emptyEl.classList.toggle("hidden", shown.length > 0);
  listEl.innerHTML = "";

  let lastDay = "";
  for (const e of shown) {
    const day = dayLabel(e.startTime);
    if (day !== lastDay) {
      lastDay = day;
      const head = document.createElement("div");
      head.className = "day";
      head.innerHTML = `<span class="eyebrow">${esc(day)}</span><span class="rule"></span>`;
      listEl.appendChild(head);
    }

    const host = hostOf(e.tabUrl);
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="when">${esc(clock(e.startTime))}</span>
      <div class="body">
        <p class="title">${esc(e.title || "Untitled lecture")}</p>
        <div class="sub">
          <span>${esc(duration(e))}</span>
          <span class="dot">·</span>
          <span>${e.segmentCount} segment${e.segmentCount === 1 ? "" : "s"}</span>
          ${host ? `<span class="dot">·</span><span class="host">${esc(host)}</span>` : ""}
        </div>
        ${
          e.topics?.length
            ? `<div class="topics">${e.topics
                .slice(0, 5)
                .map((t) => `<span class="tag">${esc(t)}</span>`)
                .join("")}</div>`
            : ""
        }
      </div>
      <div class="acts">
        <button class="act primary" data-open="summary" ${e.hasSummary ? "" : "disabled title='No summary was generated for this lecture'"}>Summary</button>
        <button class="act" data-open="transcript">Transcript</button>
        <button class="act del" data-del="1">Delete</button>
      </div>
    `;

    row.querySelector<HTMLButtonElement>("[data-open='summary']")!.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`pages/summary.html?sid=${e.id}`) });
    });
    row.querySelector<HTMLButtonElement>("[data-open='transcript']")!.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`pages/transcript.html?sid=${e.id}`) });
    });

    const del = row.querySelector<HTMLButtonElement>("[data-del]")!;
    del.addEventListener("click", async () => {
      if (!del.classList.contains("armed")) {
        del.classList.add("armed");
        del.textContent = "Sure?";
        setTimeout(() => {
          del.classList.remove("armed");
          del.textContent = "Delete";
        }, 3000);
        return;
      }
      await chrome.runtime.sendMessage({ type: "DELETE_HISTORY_ENTRY", sessionId: e.id });
      entries = entries.filter((x) => x.id !== e.id);
      render();
    });

    listEl.appendChild(row);
  }
}

qEl.addEventListener("input", render);

(async () => {
  const resp = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
  entries = Array.isArray(resp?.history) ? resp.history : [];
  entries.sort((a, b) => b.startTime - a.startTime);
  render();
})();
