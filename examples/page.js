// The page's own script: shows what the element reports. The page never sees
// a claim; the server does, after the exchange or a status read.
const log = document.getElementById("log");
const line = (text) => {
  log.textContent += `${new Date().toISOString().slice(11, 19)} ${text}\n`;
};
line(`detected: ${JSON.stringify(VerySafeVerify.detect())}`);
// Diagnostics for a same-device return: whether this browser context keeps
// the id the library stored at the tap, and whether storage works at all.
(() => {
  let storage = "localStorage ok";
  try {
    localStorage.setItem("verysafe-example-probe", "1");
    localStorage.removeItem("verysafe-example-probe");
  } catch (error) {
    storage = `localStorage throws: ${error && error.name}`;
  }
  const kept = (() => {
    try {
      return localStorage.getItem("verysafe-verify");
    } catch {
      return null;
    }
  })();
  line(`storage: ${storage}; stored id: ${kept ? JSON.parse(kept).id : "none"}; referrer: ${document.referrer || "none"}; standalone: ${navigator.standalone === true}`);
})();
// For testing: ?flow=same_device|cross_device|dc_api skips detection.
const preferred = new URLSearchParams(location.search).get("flow");
if (preferred) document.querySelector("verysafe-verify").setAttribute("prefer-flow", preferred);
document.addEventListener("verysafe-verify:flow", (e) => line(`flow: ${e.detail.flow}`));
document.addEventListener("verysafe-verify:status", (e) => line(`status: ${e.detail.status}`));
document.addEventListener("verysafe-verify:result", (e) => line(`result: ${JSON.stringify(e.detail)}`));
