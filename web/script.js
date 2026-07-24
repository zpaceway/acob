const menuButton = document.querySelector(".menu-button");
const navigation = document.querySelector(".site-nav");

menuButton?.addEventListener("click", () => {
  const isOpen = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!isOpen));
  navigation?.classList.toggle("open", !isOpen);
  document.body.style.overflow = isOpen ? "" : "hidden";
});

navigation?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    menuButton?.setAttribute("aria-expanded", "false");
    navigation.classList.remove("open");
    document.body.style.overflow = "";
  });
});

const tabs = document.querySelectorAll("[data-code-tab]");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const selected = tab.dataset.codeTab;

    tabs.forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });

    document.querySelectorAll(".code-panel").forEach((panel) => {
      const isActive = panel.id === `${selected}-panel`;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });
  });
});

const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());
