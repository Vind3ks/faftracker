(() => {
  function getPlayerFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return (params.get("player") || params.get("name") || "").trim();
  }

  function bootPlayerFromUrl() {
    const playerFromUrl = getPlayerFromUrl();

    if (!playerFromUrl) {
      return;
    }

    const input = document.getElementById("playerInput");
    const button = document.getElementById("loadButton");

    if (!input || !button) {
      return;
    }

    input.value = playerFromUrl;

    window.setTimeout(() => {
      if (!button.disabled) {
        button.click();
      }
    }, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootPlayerFromUrl, { once: true });
  } else {
    bootPlayerFromUrl();
  }
})();
