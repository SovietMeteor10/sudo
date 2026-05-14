// Phase 14B: /u/:handle copy-handle + copy-link buttons.
// CSP requires every script to be self-served, so this lives as a
// static file rather than inline. Read handle + link from data
// attributes set by the server-side render.
(function () {
  var meta = document.getElementById("u-profile-data");
  if (meta === null) return;
  var handle = meta.getAttribute("data-handle") || "";
  var handleNoAt = meta.getAttribute("data-handle-no-at") || "";
  var link = window.location.origin + "/u/" + encodeURIComponent(handleNoAt);
  var toast = document.getElementById("toast");
  var hideTimer = null;

  function showToast(msg) {
    if (toast === null) return;
    toast.textContent = msg;
    toast.classList.add("visible");
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      toast.classList.remove("visible");
    }, 1600);
  }

  function copyText(text, label) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(
        function () { showToast(label + " copied"); },
        function () { fallback(text, label); }
      );
    } else {
      fallback(text, label);
    }
  }

  function fallback(text, label) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(label + " copied");
    } catch (e) {
      showToast("copy failed");
    }
    document.body.removeChild(ta);
  }

  var copyHandle = document.getElementById("copy-handle");
  var copyLink = document.getElementById("copy-link");
  if (copyHandle !== null) {
    copyHandle.addEventListener("click", function () { copyText(handle, "handle"); });
  }
  if (copyLink !== null) {
    copyLink.addEventListener("click", function () { copyText(link, "link"); });
  }
})();
