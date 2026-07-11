// Focus navigation for D-pad remotes.
//
// Three ideas combined:
//   1. Row-aware: inside a horizontal group (hero action buttons, or a
//      movie row), Left/Right moves to the DOM sibling and Up/Down jumps
//      to the same column position in the group above/below. This is how
//      every real TV browse UI (Netflix, Apple TV, etc.) behaves —
//      predictable and unaffected by the focused card's own scale-up
//      transform changing its bounding box mid-move.
//   2. Sidenav-aware: the left rail is a vertical group. Up/Down moves
//      within it; Right escapes into the main content (restoring wherever
//      you last were there), Left from the main content's first column
//      escapes back into the sidenav (restoring wherever you last were
//      there too) — same "remember each side's position" pattern most TV
//      home screens use.
//   3. Geometric fallback: for anything outside those groups (modals),
//      fall back to nearest-candidate-by-position, same idea as the WICG
//      spatial-navigation draft.
(function () {
  "use strict";

  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "[tabindex='0']",
  ].join(",");

  const SIDENAV_SELECTOR = ".tv-sidenav-items";
  const MAIN_GROUP_SELECTOR = ".tv-hero-actions, .tv-row-track";
  const GROUP_SELECTOR = `${SIDENAV_SELECTOR}, ${MAIN_GROUP_SELECTOR}`;

  let lastMainFocus = null;
  let lastSidenavFocus = null;

  function isVisible(el) {
    if (!el || el.hasAttribute("disabled")) return false;
    if (el.closest("[hidden]")) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function focusScope() {
    const player = document.getElementById("player-overlay");
    if (player && !player.hidden) return player;
    const version = document.getElementById("version-modal");
    if (version && !version.hidden) return version;
    const modal = document.getElementById("download-modal");
    if (modal && !modal.hidden) return modal;
    const detail = document.getElementById("detail-page");
    if (detail && !detail.hidden) return detail;
    const search = document.getElementById("search-overlay");
    if (search && !search.hidden) return search;
    return document;
  }

  function getFocusable() {
    return [...focusScope().querySelectorAll(FOCUSABLE_SELECTOR)].filter(isVisible);
  }

  function getGroupFor(el) {
    if (focusScope() !== document) return null; // modals don't use row/sidenav grouping
    const group = el.closest(GROUP_SELECTOR);
    if (!group) return null;
    return { element: group, isSidenav: group.matches(SIDENAV_SELECTOR) };
  }

  function getGroupChildren(group) {
    return [...group.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isVisible);
  }

  function getOrderedMainGroups() {
    if (focusScope() !== document) return [];
    return [...document.querySelectorAll(MAIN_GROUP_SELECTOR)].filter((g) => getGroupChildren(g).length > 0);
  }

  function isInDirection(direction, curRect, rect) {
    const epsilon = 1;
    switch (direction) {
      case "left":
        return rect.right <= curRect.left + epsilon;
      case "right":
        return rect.left >= curRect.right - epsilon;
      case "up":
        return rect.bottom <= curRect.top + epsilon;
      case "down":
        return rect.top >= curRect.bottom - epsilon;
      default:
        return false;
    }
  }

  function score(direction, curRect, rect) {
    const curCx = curRect.left + curRect.width / 2;
    const curCy = curRect.top + curRect.height / 2;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = cx - curCx;
    const dy = cy - curCy;
    if (direction === "left" || direction === "right") {
      return Math.abs(dx) + Math.abs(dy) * 3;
    }
    return Math.abs(dy) + Math.abs(dx) * 3;
  }

  function currentElement() {
    const active = document.activeElement;
    if (active && active !== document.body && isVisible(active)) return active;
    return null;
  }

  function setFocused(el) {
    if (!el) return;
    document.querySelectorAll(".tv-focused").forEach((n) => n.classList.remove("tv-focused"));
    el.classList.add("tv-focused");
    el.focus({ preventScroll: false });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });

    if (el.closest(SIDENAV_SELECTOR)) {
      lastSidenavFocus = el;
    } else if (focusScope() === document) {
      lastMainFocus = el;
    }
  }

  function focusFirst() {
    const candidates = getFocusable();
    if (!candidates.length) return;

    const modalPreferred = candidates.find(
      (el) =>
        el.closest("#download-modal") ||
        el.closest("#detail-page") ||
        el.closest("#search-overlay") ||
        el.closest("#version-modal")
    );
    if (modalPreferred) {
      setFocused(modalPreferred);
      return;
    }

    // Prefer the hero, then the first row, over the sidenav — a fresh
    // load or a lost focus should land you back browsing, not on Refresh.
    const heroActions = document.querySelector(".tv-hero-actions");
    const heroChildren = heroActions ? getGroupChildren(heroActions) : [];
    if (heroChildren.length) {
      setFocused(heroChildren[0]);
      return;
    }

    const firstRow = document.querySelector(".tv-row-track");
    const rowChildren = firstRow ? getGroupChildren(firstRow) : [];
    if (rowChildren.length) {
      setFocused(rowChildren[0]);
      return;
    }

    setFocused(candidates[0]);
  }

  function geometricMove(direction, current) {
    const candidates = getFocusable();
    const curRect = current.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;

    for (const el of candidates) {
      if (el === current) continue;
      const rect = el.getBoundingClientRect();
      if (!isInDirection(direction, curRect, rect)) continue;
      const s = score(direction, curRect, rect);
      if (s < bestScore) {
        bestScore = s;
        best = el;
      }
    }

    if (best) {
      setFocused(best);
      return true;
    }
    return false;
  }

  function moveWithinGroup(delta, group, current) {
    const siblings = getGroupChildren(group);
    const idx = siblings.indexOf(current);
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= siblings.length) return false;
    setFocused(siblings[nextIdx]);
    return true;
  }

  function moveBetweenMainGroups(direction, group, current) {
    const groups = getOrderedMainGroups();
    const groupIndex = groups.indexOf(group);
    if (groupIndex === -1) return false;

    const targetIndex = direction === "up" ? groupIndex - 1 : groupIndex + 1;
    if (targetIndex < 0 || targetIndex >= groups.length) return false;

    const currentChildren = getGroupChildren(group);
    const curIdxInGroup = Math.max(0, currentChildren.indexOf(current));
    const targetChildren = getGroupChildren(groups[targetIndex]);
    if (!targetChildren.length) return false;

    const targetIdx = Math.min(curIdxInGroup, targetChildren.length - 1);
    setFocused(targetChildren[targetIdx]);
    return true;
  }

  function sidenavPanel() {
    return document.getElementById("sidenav");
  }

  function isSidenavOpen() {
    return Boolean(sidenavPanel()?.classList.contains("open"));
  }

  function escapeMainToSidenav() {
    const sidenav = document.querySelector(SIDENAV_SELECTOR);
    if (!sidenav) return false;
    const children = getGroupChildren(sidenav);
    if (!children.length) return false;
    sidenavPanel()?.classList.add("open");
    const remembered = lastSidenavFocus && children.includes(lastSidenavFocus) ? lastSidenavFocus : null;
    setFocused(remembered || children[0]);
    return true;
  }

  function escapeSidenavToMain() {
    sidenavPanel()?.classList.remove("open");
    if (lastMainFocus && document.contains(lastMainFocus) && isVisible(lastMainFocus)) {
      setFocused(lastMainFocus);
      return true;
    }
    const groups = getOrderedMainGroups();
    if (!groups.length) return false;
    const children = getGroupChildren(groups[0]);
    if (!children.length) return false;
    setFocused(children[0]);
    return true;
  }

  function closeSidenav() {
    if (!isSidenavOpen()) return false;
    return escapeSidenavToMain();
  }

  function moveFocus(direction) {
    const candidates = getFocusable();
    if (!candidates.length) return false;

    const current = currentElement();
    if (!current) {
      focusFirst();
      return true;
    }

    const groupInfo = getGroupFor(current);
    if (groupInfo) {
      const { element: group, isSidenav } = groupInfo;

      if (isSidenav) {
        if (direction === "up" || direction === "down") {
          if (moveWithinGroup(direction === "up" ? -1 : 1, group, current)) return true;
          return false; // top/bottom edge of the sidenav: no-op
        }
        if (direction === "right") return escapeSidenavToMain();
        return false; // left: already the leftmost thing on screen
      }

      // Main content (hero actions / row tracks) are horizontal groups.
      if (direction === "left" || direction === "right") {
        if (moveWithinGroup(direction === "left" ? -1 : 1, group, current)) return true;
        if (direction === "left") return escapeMainToSidenav();
        return false; // right edge of a row: no wraparound
      }

      if (moveBetweenMainGroups(direction, group, current)) return true;
    }

    return geometricMove(direction, current);
  }

  function activateFocused() {
    const current = currentElement();
    if (!current) return false;
    current.click();
    return true;
  }

  // Re-sync the visible focus ring whenever focus changes via Tab, click,
  // or programmatic .focus() elsewhere in the app.
  document.addEventListener(
    "focus",
    (e) => {
      document.querySelectorAll(".tv-focused").forEach((n) => n.classList.remove("tv-focused"));
      if (e.target instanceof Element) e.target.classList.add("tv-focused");
    },
    true
  );

  document.addEventListener(
    "blur",
    (e) => {
      if (e.target instanceof Element) e.target.classList.remove("tv-focused");
    },
    true
  );

  window.TVFocusManager = {
    moveFocus,
    activateFocused,
    focusFirst,
    getFocusable,
    isSidenavOpen,
    closeSidenav,
  };
})();
