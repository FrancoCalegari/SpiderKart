(function () {
  // 1. Detectar preferencia guardada o del sistema
  const storedTheme = localStorage.getItem("theme");
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  let currentTheme = storedTheme || (prefersLight ? "light" : "dark");

  // 2. Aplicar inmediatamente (antes del paint)
  if (currentTheme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  }

  // 3. Agregar botón toggle al navbar cuando el DOM esté listo
  window.addEventListener("DOMContentLoaded", () => {
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "theme-toggle-btn";
    toggleBtn.className = "theme-toggle-btn sw-btn--ghost";
    toggleBtn.setAttribute("aria-label", "Cambiar tema");

    const updateIcon = (theme) => {
      toggleBtn.innerHTML =
        theme === "light"
          ? `<i class="fa-solid fa-moon"></i>`
          : `<i class="fa-solid fa-sun"></i>`;
    };
    updateIcon(currentTheme);

    toggleBtn.addEventListener("click", () => {
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      const newTheme = isLight ? "dark" : "light";
      if (newTheme === "light") {
        document.documentElement.setAttribute("data-theme", "light");
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
      localStorage.setItem("theme", newTheme);
      updateIcon(newTheme);
    });

    // Insertar en el navbar (busca por id o clase)
    const navLinks = document.getElementById("navMenu") || document.querySelector(".sw-nav__links");
    if (navLinks) {
      const li = document.createElement("li");
      li.appendChild(toggleBtn);
      navLinks.appendChild(li);
    } else {
      document.body.appendChild(toggleBtn);
    }
  });
})();
