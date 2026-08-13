/** Browser-side stub for platform.getbring.com/widgets/import.js. */
export const BRING_WIDGET_STUB = `
window.__bringImportCalls = window.__bringImportCalls || [];
window.bringwidgets = {
  import: {
    render: function (el, config) {
      window.__bringImportCalls.push(config);
      el.setAttribute("data-testid", "bring-import-widget");
      var a = document.createElement("a");
      a.href = "#";
      a.textContent = "Add to Bring!";
      el.replaceChildren(a);
    },
  },
};
`;
