/*
 * Webview-only SVG diff highlighting.
 *
 * The extension sends both revisions after the user presses the preview button.
 * This script compares SVG elements and places boxes around changed rendered
 * elements without depending on source line numbers or element IDs.
 */

export const TOGGLE_SVG_DIFF_HIGHLIGHT_COMMAND = "pandocManuscriptTools.toggleSvgDiffHighlight";

/** Builds the SVG element comparison and overlay script for a preview webview. */
export function buildSvgDiffHighlightScript(): string {
  return `<style>
    .stage { position: relative; }
    .svgDiffOverlay { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
    .svgDiffRegion {
      position: absolute;
      box-sizing: border-box;
      border: 2px solid var(--vscode-editorWarning-foreground, #e6ac32);
      background: rgba(245, 181, 45, 0.16);
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45), 0 0 9px rgba(245, 181, 45, 0.75);
    }
    [data-preview-command="pandocManuscriptTools.toggleSvgDiffHighlight"][aria-pressed="true"] {
      color: var(--vscode-editorWarning-foreground, #e6ac32);
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
    }
    .svgDiffStatus { color: var(--vscode-descriptionForeground); font-size: 0.85em; white-space: nowrap; }
  </style><script>
(() => {
  const stage = document.querySelector("[data-preview-stage]");
  const frame = document.querySelector('[data-preview-kind="inline-svg"]');
  const button = document.querySelector('[data-preview-command="pandocManuscriptTools.toggleSvgDiffHighlight"]');
  if (!stage || !frame || !button) return;

  const overlay = document.createElement("div");
  overlay.className = "svgDiffOverlay";
  stage.appendChild(overlay);
  const status = document.createElement("span");
  status.className = "svgDiffStatus";
  status.setAttribute("role", "status");
  button.parentElement.appendChild(status);
  let highlightedPaths = [];
  let enabled = false;
  let updateFrame = 0;

  /** Ignores non-rendering content removed from the inline preview for safety. */
  function isIgnored(element) {
    return ["script", "foreignObject", "metadata", "title", "desc"].includes(element.localName);
  }

  /** Returns SVG element children in the same order as the displayed preview. */
  function childrenOf(element) {
    return Array.from(element.children).filter((child) => !isIgnored(child));
  }

  /** Normalizes element attributes so formatting-only XML edits are ignored. */
  function attributeKey(element) {
    return Array.from(element.attributes)
      .map((attribute) => attribute.name + "=" + attribute.value.trim())
      .sort().join("|");
  }

  /** Creates a structural key used to keep unchanged siblings aligned. */
  function signature(element) {
    const children = childrenOf(element);
    const text = children.length ? "" : (element.textContent || "").trim().replace(/\\s+/g, " ");
    return element.localName + "[" + attributeKey(element) + "]" + text
      + "{" + children.map(signature).join(";") + "}";
  }

  /** Aligns siblings by ID, then unchanged content, then nearby same-tag nodes. */
  function pairChildren(current, other) {
    const currentChildren = childrenOf(current);
    const otherChildren = childrenOf(other);
    const pairs = [];
    const usedCurrent = new Set();
    const usedOther = new Set();
    const otherIds = new Map();
    otherChildren.forEach((child, index) => {
      if (child.id && !otherIds.has(child.id)) otherIds.set(child.id, index);
    });
    currentChildren.forEach((child, index) => {
      const match = otherIds.get(child.id);
      if (child.id && match !== undefined && !usedOther.has(match)
          && child.localName === otherChildren[match].localName) {
        pairs.push([index, match]);
        usedCurrent.add(index);
        usedOther.add(match);
      }
    });

    const left = currentChildren.map((_, index) => index).filter((index) => !usedCurrent.has(index));
    const right = otherChildren.map((_, index) => index).filter((index) => !usedOther.has(index));
    if (left.length * right.length <= 40000) {
      const leftKeys = left.map((index) => signature(currentChildren[index]));
      const rightKeys = right.map((index) => signature(otherChildren[index]));
      const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
      for (let i = left.length - 1; i >= 0; i -= 1) {
        for (let j = right.length - 1; j >= 0; j -= 1) {
          lengths[i][j] = leftKeys[i] === rightKeys[j]
            ? lengths[i + 1][j + 1] + 1
            : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < left.length && j < right.length) {
        if (leftKeys[i] === rightKeys[j]) {
          pairs.push([left[i], right[j]]);
          usedCurrent.add(left[i]);
          usedOther.add(right[j]);
          i += 1;
          j += 1;
        } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
          i += 1;
        } else {
          j += 1;
        }
      }
    }

    currentChildren.forEach((child, index) => {
      if (usedCurrent.has(index)) return;
      const match = otherChildren.findIndex((candidate, otherIndex) =>
        !usedOther.has(otherIndex) && candidate.localName === child.localName);
      if (match >= 0) {
        pairs.push([index, match]);
        usedCurrent.add(index);
        usedOther.add(match);
      }
    });
    return { currentChildren, otherChildren, pairs, usedCurrent };
  }

  /** Finds the smallest changed elements on the currently displayed side. */
  function changedPaths(current, other) {
    const changes = [];
    function visit(left, right, path) {
      if (left.localName !== right.localName || attributeKey(left) !== attributeKey(right)) {
        changes.push(path);
        return;
      }
      const leftChildren = childrenOf(left);
      const rightChildren = childrenOf(right);
      if (!leftChildren.length && !rightChildren.length) {
        if ((left.textContent || "").trim().replace(/\\s+/g, " ")
            !== (right.textContent || "").trim().replace(/\\s+/g, " ")) changes.push(path);
        return;
      }
      const match = pairChildren(left, right);
      match.currentChildren.forEach((_, index) => {
        if (!match.usedCurrent.has(index)) changes.push(path.concat(index));
      });
      match.pairs.forEach(([leftIndex, rightIndex]) =>
        visit(match.currentChildren[leftIndex], match.otherChildren[rightIndex], path.concat(leftIndex)));
      // A removed element is highlighted on the revision where it still exists.
    }
    visit(current, other, []);
    return changes;
  }

  /** Resolves a source element path against the safely displayed inline SVG. */
  function displayedElement(path) {
    let element = frame.querySelector("svg");
    for (const index of path) {
      element = element && childrenOf(element)[index];
    }
    return element;
  }

  /** Draws region boxes using browser layout after zoom and SVG transforms. */
  function renderRegions() {
    updateFrame = 0;
    overlay.replaceChildren();
    if (!enabled) return;
    const stageRect = stage.getBoundingClientRect();
    let count = 0;
    for (const path of highlightedPaths.slice(0, 200)) {
      const element = displayedElement(path);
      if (!element) continue;
      let rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        // Definitions have no box; the root warns that their visual effect can be broad.
        rect = frame.getBoundingClientRect();
      }
      const box = document.createElement("div");
      box.className = "svgDiffRegion";
      box.style.left = (rect.left - stageRect.left - 3) + "px";
      box.style.top = (rect.top - stageRect.top - 3) + "px";
      box.style.width = Math.max(8, rect.width + 6) + "px";
      box.style.height = Math.max(8, rect.height + 6) + "px";
      overlay.appendChild(box);
      count += 1;
    }
    status.textContent = count ? count + " changed area" + (count === 1 ? "" : "s") : "No changed elements on this side";
  }

  /** Coalesces resize and zoom updates into one layout measurement. */
  function scheduleRegions() {
    if (!updateFrame) updateFrame = setTimeout(renderRegions, 0);
  }

  /** Parses one revision without executing SVG scripts. */
  function parseSvg(svg) {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    return document.querySelector("parsererror") ? null : document.documentElement;
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.type !== "svgDiffHighlight") return;
    enabled = message.enabled === true;
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? "Hide changed areas" : "Highlight changed areas";
    if (!enabled) {
      highlightedPaths = [];
      status.textContent = "";
      scheduleRegions();
      return;
    }
    const current = parseSvg(message.currentSvg);
    const other = parseSvg(message.otherSvg);
    if (!current || !other || current.localName !== "svg" || other.localName !== "svg") {
      status.textContent = "SVG could not be compared";
      enabled = false;
      button.setAttribute("aria-pressed", "false");
      scheduleRegions();
      return;
    }
    highlightedPaths = changedPaths(current, other);
    scheduleRegions();
  });
  new MutationObserver(scheduleRegions).observe(frame, { attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", scheduleRegions);
})();
</script>`;
}
