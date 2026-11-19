import {
  THROWABLE_ORDER,
  getThrowablePair,
  type PlayerLoadoutPayload,
  type ThrowableType,
} from "@game/shared";

export const THROWABLE_LABELS = {
  frag: { name: "Frag", icon: "●" },
  flashbang: { name: "Flashbang", icon: "✦" },
  smoke: { name: "Smoke", icon: "☁" },
} as const;

export function renderTdmThrowables(loadout: PlayerLoadoutPayload): string {
  const pair = getThrowablePair(loadout.throwable, loadout.tdmThrowables);
  return `
    <div class="panel-title">TDM throwables</div>
    <div class="chip-row">
      ${pair.map((equipped, index) => `
        <label>Slot ${index + 1}
          <select class="text-input" data-tdm-throwable-slot="${index}" style="text-transform:none;">
            ${THROWABLE_ORDER.map((kind) => `
              <option value="${kind}" ${equipped === kind ? "selected" : ""}>${THROWABLE_LABELS[kind].name}</option>
            `).join("")}
          </select>
        </label>
      `).join("")}
    </div>
  `;
}

export function bindTdmThrowables(
  root: ParentNode,
  loadout: PlayerLoadoutPayload,
  onChange: () => void
): void {
  const slots = Array.from(root.querySelectorAll<HTMLSelectElement>("[data-tdm-throwable-slot]"));
  for (const [index, slot] of slots.entries()) {
    slot.addEventListener("change", () => {
      const kind = slot.value as ThrowableType;
      const pair = getThrowablePair(loadout.throwable, loadout.tdmThrowables);
      const other = index === 0 ? 1 : 0;
      if (pair[other] === kind) pair[other] = pair[index];
      pair[index] = kind;
      loadout.tdmThrowables = pair;
      slots[other].value = pair[other];
      onChange();
    });
  }
}
